import { chmod, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	bundleNodeEntries,
	copyPackageFiles,
	hashPackageFiles,
	parseFlagMap,
	prepareOutputDir,
	readLinuxX64Elf,
	sha256Hex,
	writeManifest,
} from "./package-service.mjs";

const USAGE = "Usage: node scripts/package-folder-service.mjs --out <new-directory> --folder-program <built qorpera-folder>";
const options = parseFlagMap(process.argv.slice(2), { allowed: ["--out", "--folder-program"], usage: USAGE });
if (!options.has("--out") || !options.has("--folder-program")) throw new Error(USAGE);
const output = await prepareOutputDir(resolve(options.get("--out")), { mode: 0o755 });
const program = resolve(options.get("--folder-program"));

await bundleNodeEntries({
	entries: [["packages/object-gateway/src/folder-service/cli.ts", "qorpera-folder-service.cjs"]],
	outputRoot: output,
	format: "cjs",
});
await readLinuxX64Elf(program, "--folder-program must be the x86-64 Linux build of crates/qorpera-folder");
await copyFile(program, join(output, "qorpera-folder"));
await chmod(join(output, "qorpera-folder"), 0o755);

const deployed = [
	"qorpera-folder-service.socket",
	"qorpera-folder-control.socket",
	"qorpera-folder-service.service",
	"qorpera-folder-bridge.service",
	"install-folder-service.sh",
	"README.md",
];
await copyPackageFiles(
	deployed.map((file) => [`deploy/folder-service/${file}`, file, file === "install-folder-service.sh" ? 0o755 : undefined]),
	output,
);
const artifacts = await hashPackageFiles(["qorpera-folder-service.cjs", "qorpera-folder", ...deployed], output);
const manifest = {
	schema: "qorpera.folder-service-package/v1",
	runtime: { node: ">=22.19.0", platform: "linux-x64" },
	artifacts,
};
const manifestText = await writeManifest(output, manifest);
console.log(JSON.stringify({ output, manifestSha256: sha256Hex(manifestText) }));
