import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { RECORD, readFolderProgramRecord } from "./folder-program-artifact.mjs";

// The company machine guest (2026-09-28): the command helper and its watchdog
// units, packaged as reviewable files with their checksums. Installing them
// into the machine image is deploy/machine/build-machine-image.sh's job.
// Since F3 step 6c it also carries the company folder's program (the build
// RECORD names, made by scripts/build-folder-program.mjs) and its unit, which
// mounts the folder at /company once the host hands the machine a view.
const USAGE = "Usage: package-machine-guest.mjs --out <new-directory> --folder-program <built qorpera-folder>";
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--out" || args[2] !== "--folder-program") throw new Error(USAGE);
const output = resolve(args[1]);
const units = [
	"qorpera-machine.slice",
	"qorpera-machine-watchdog.service",
	"qorpera-machine-watchdog.timer",
	"qorpera-machine-folder.service",
];
await Promise.all(units.map((unit) => readFile(`deploy/machine/${unit}`)));
// Only the recorded build: the image script pins the same bytes.
const program = await readFile(resolve(args[3]));
const record = readFolderProgramRecord();
const programSha256 = createHash("sha256").update(program).digest("hex");
if (program.length !== record.bytes || programSha256 !== record.sha256) {
	throw new Error(`--folder-program is ${programSha256}, not the build ${RECORD} records (${record.sha256})`);
}
await mkdir(output, { recursive: false, mode: 0o700 });
const artifacts = [];
await build({
	entryPoints: ["packages/runtime/src/cloud-machine-guest.ts"],
	outfile: resolve(output, "cloud-machine-guest.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22.19",
	legalComments: "none",
	logLevel: "silent",
});
const helper = await readFile(resolve(output, "cloud-machine-guest.mjs"));
// The executor re-reads the helper through LXD's 64 KiB file read to check its pin.
if (helper.length > 65536) throw new Error("Machine guest helper exceeds the protected transport bound");
artifacts.push({
	file: "cloud-machine-guest.mjs",
	source: "packages/runtime/src/cloud-machine-guest.ts",
	installedPath: "/opt/qorpera-machine/cloud-machine-guest.mjs",
	owner: "root:root",
	mode: "0444",
	sha256: createHash("sha256").update(helper).digest("hex"),
	bytes: helper.length,
});
for (const unit of units) {
	const bytes = await readFile(`deploy/machine/${unit}`);
	await writeFile(resolve(output, unit), bytes, { mode: 0o644 });
	artifacts.push({
		file: unit,
		source: `deploy/machine/${unit}`,
		installedPath: `/etc/systemd/system/${unit}`,
		owner: "root:root",
		mode: "0644",
		sha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.length,
	});
}
await writeFile(resolve(output, "qorpera-folder"), program, { mode: 0o755 });
artifacts.push({
	file: "qorpera-folder",
	source: RECORD,
	installedPath: "/opt/qorpera-folder/qorpera-folder",
	owner: "root:root",
	mode: "0555",
	sha256: programSha256,
	bytes: program.length,
});
// The node proof (deploy/machine/prove-machine-node.ts) is packaged beside it for
// the operator; it is never installed in the image.
await build({
	entryPoints: ["deploy/machine/prove-machine-node.ts"],
	outfile: resolve(output, "prove-machine-node.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22.19",
	legalComments: "none",
	logLevel: "silent",
});
const manifest = `${JSON.stringify({ schema: "qorpera.machine-guest-package/v1", artifacts, installationPerformed: false }, null, 2)}\n`;
await writeFile(resolve(output, "manifest.json"), manifest, { mode: 0o600 });
console.log(JSON.stringify({ output, helperSha256: artifacts[0].sha256, bytes: helper.length }));
