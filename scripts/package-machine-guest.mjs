import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

// The company machine guest (2026-09-28): the command helper and its watchdog
// units, packaged as reviewable files with their checksums. Installing them
// into the machine image is deploy/machine/build-machine-image.sh's job.
if (process.argv.length !== 4 || process.argv[2] !== "--out") {
	throw new Error("Usage: package-machine-guest.mjs --out <new-directory>");
}
const output = resolve(process.argv[3]);
const units = ["qorpera-machine.slice", "qorpera-machine-watchdog.service", "qorpera-machine-watchdog.timer"];
await Promise.all(units.map((unit) => readFile(`deploy/machine/${unit}`)));
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
const manifest = `${JSON.stringify({ schema: "qorpera.machine-guest-package/v1", artifacts, installationPerformed: false }, null, 2)}\n`;
await writeFile(resolve(output, "manifest.json"), manifest, { mode: 0o600 });
console.log(JSON.stringify({ output, helperSha256: artifacts[0].sha256, bytes: helper.length }));
