import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { jitlessServiceBundleOptions } from "./jitless-service-bundle.mjs";
import {
	bundleNodeEntries,
	copyPackageFiles,
	hashPackageFiles,
	parseFlagMap,
	prepareOutputDir,
	readLinuxX64Elf,
	writeManifest,
} from "./package-service.mjs";

const USAGE =
	"Usage: node scripts/package-shared-execution-service.mjs [--out <directory>] --folder-program <built qorpera-folder>";
const options = parseFlagMap(process.argv.slice(2), { allowed: ["--out", "--folder-program"], usage: USAGE });
if (!options.has("--folder-program")) throw new Error(USAGE);
const outputRoot = resolve(options.get("--out") ?? ".artifacts/shared-execution");
const folderProgram = resolve(options.get("--folder-program"));
if (folderProgram.startsWith(`${outputRoot}/`)) throw new Error("--folder-program must not be inside --out");
const program = await readLinuxX64Elf(
	folderProgram,
	"--folder-program must be the x86-64 Linux build of crates/qorpera-folder",
);
await prepareOutputDir(outputRoot, { clean: true });

const entries = [
	["packages/runner-orchestrator/src/shared-execution-cli.ts", "qorpera-shared-execution-service.mjs"],
	["packages/runner-orchestrator/src/cli.ts", "qorpera-runner-orchestrator.mjs"],
];
await bundleNodeEntries({ entries, outputRoot, extraOptions: jitlessServiceBundleOptions });
const copies = [
	"deploy/shared-execution/qorpera-shared-execution.service",
	"deploy/shared-execution/qorpera-shared-run-host@.service",
	"deploy/shared-execution/qorpera-shared-runner@.service",
	"deploy/shared-execution/shared-execution.env.example",
	"deploy/shared-execution/install-shared-execution-guest.sh",
	"deploy/first-node/qorpera-runner-orchestrator.service",
	"deploy/folder-service/qorpera-folder-mount@.service",
	"deploy/shared-execution/qorpera-folder-relay@.socket",
	"deploy/shared-execution/qorpera-folder-relay@.service",
];
await copyPackageFiles(copies, outputRoot);
await writeFile(resolve(outputRoot, "qorpera-folder"), program);
await chmod(resolve(outputRoot, "qorpera-folder"), 0o755);

const files = [...entries.map(([, file]) => file), ...copies.map((source) => source.split("/").at(-1)), "qorpera-folder"].sort(
	(a, b) => a.localeCompare(b, "en"),
);
const artifacts = await hashPackageFiles(files, outputRoot);
await writeManifest(outputRoot, {
	schema: "qorpera.shared-execution-package/v1",
	runtime: { node: ">=22.19.0", systemd: ">=255" },
	artifacts,
});
console.log(outputRoot);
