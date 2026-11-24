import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CODING_GUEST_HELPER_MAX_BYTES } from "../packages/contracts/src/cloud-coding-command.ts";
import {
	bundleNodeEntries,
	parseOutArg,
	prepareOutputDir,
	sha256Hex,
	writeManifest,
} from "./package-service.mjs";

const output = parseOutArg(process.argv.slice(2), {
	usage: "Usage: package-coding-guest.mjs --out <new-directory>",
});
const sources = [
	["packages/runtime/src/cloud-coding-storage-guest-main.ts", "cloud-coding-storage-guest.mjs"],
	["packages/runtime/src/cloud-coding-command-guest.ts", "cloud-coding-command-guest.mjs"],
	["packages/runtime/src/cloud-coding-git-guest.ts", "cloud-coding-git-guest.mjs"],
	["packages/runtime/src/cloud-coding-watchdog-main.ts", "cloud-coding-watchdog.mjs"],
];
await Promise.all(sources.map(([source]) => readFile(source)));
const installation = JSON.parse(await readFile("deploy/coding-worker/command-guest-installation.json", "utf8"));
await prepareOutputDir(output, { mode: 0o700 });
await bundleNodeEntries({ entries: sources, outputRoot: output, root: process.cwd() });
const artifacts = [];
for (const [source, file] of sources) {
	const bytes = await readFile(resolve(output, file));
	if (bytes.length > CODING_GUEST_HELPER_MAX_BYTES) {
		throw new Error(`Coding guest artifact exceeds protected transport bound: ${file}`);
	}
	artifacts.push({
		file,
		source,
		installedPath: `/opt/qorpera-coding/${file}`,
		owner: "root:root",
		mode: "0444",
		sha256: sha256Hex(bytes),
		bytes: bytes.length,
	});
}
await writeManifest(
	output,
	{ schema: "qorpera.coding-guest-package/v1", artifacts, installation, installationPerformed: false },
	{ mode: 0o600 },
);
console.log(output);
