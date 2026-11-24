import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	bundleNodeEntries,
	parseOutArg,
	prepareOutputDir,
	sha256Hex,
	writeManifest,
} from "./package-service.mjs";

const output = await prepareOutputDir(
	parseOutArg(process.argv.slice(2), {
		usage: "Usage: package-coding-guest-agent.mjs --out <new-directory>",
	}),
	{ mode: 0o700 },
);
const source = "packages/runtime/src/cloud-coding-guest-agent.ts";
await bundleNodeEntries({ entries: [[source, "agent.mjs"]], outputRoot: output });
const agent = await readFile(resolve(output, "agent.mjs"));
if (agent.length > 262144) throw new Error("Coding guest agent exceeds the protected transport bound");
const artifacts = [
	{
		file: "agent.mjs",
		source,
		installedPath: "/opt/qorpera-guest/agent.mjs",
		owner: "root:root",
		mode: "0444",
		sha256: sha256Hex(agent),
		bytes: agent.length,
	},
];
await writeManifest(
	output,
	{ schema: "qorpera.coding-guest-agent-package/v1", artifacts, installationPerformed: false },
	{ mode: 0o600 },
);
console.log(JSON.stringify({ output, agentSha256: artifacts[0].sha256, bytes: agent.length }));
