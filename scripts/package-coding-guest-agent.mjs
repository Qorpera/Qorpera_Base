import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

// The coding guest agent (F3 step 5g-2c; packages/runtime/src/cloud-coding-guest-agent.ts), bundled into one file
// with its checksum. The base image only makes /opt/qorpera-guest; the executor pushes the agent there at each start.
if (process.argv.length !== 4 || process.argv[2] !== "--out") {
	throw new Error("Usage: package-coding-guest-agent.mjs --out <new-directory>");
}
const output = resolve(process.argv[3]);
await mkdir(output, { recursive: false, mode: 0o700 });
await build({
	entryPoints: ["packages/runtime/src/cloud-coding-guest-agent.ts"],
	outfile: resolve(output, "agent.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22.19",
	legalComments: "none",
	logLevel: "silent",
});
const agent = await readFile(resolve(output, "agent.mjs"));
// The executor pushes the agent through the LXD client's 256 KiB file write.
if (agent.length > 262144) throw new Error("Coding guest agent exceeds the protected transport bound");
const artifacts = [
	{
		file: "agent.mjs",
		source: "packages/runtime/src/cloud-coding-guest-agent.ts",
		installedPath: "/opt/qorpera-guest/agent.mjs",
		owner: "root:root",
		mode: "0444",
		sha256: createHash("sha256").update(agent).digest("hex"),
		bytes: agent.length,
	},
];
const manifest = `${JSON.stringify({ schema: "qorpera.coding-guest-agent-package/v1", artifacts, installationPerformed: false }, null, 2)}\n`;
await writeFile(resolve(output, "manifest.json"), manifest, { mode: 0o600 });
console.log(JSON.stringify({ output, agentSha256: artifacts[0].sha256, bytes: agent.length }));
