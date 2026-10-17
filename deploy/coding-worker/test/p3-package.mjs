// Builds what P3 (test/prove-coding-session-vm.sh) pushes, from this checkout, into a new directory:
//
//   node deploy/coding-worker/test/p3-package.mjs --out <new directory>
//     guest/         today's coding guest package (scripts/package-coding-guest.mjs: the image's /opt/qorpera-coding)
//     p3/p3-executor.mjs  the node's executor composition (p3-executor.ts)
//     p3/p3-gateway.mjs   the runtime's coding command gateway, for the driver (the runtime's side of the HTTP)
//     p3/p3-objects.mjs   the node's object gateway for the folder service's writes (p3-objects.ts)
//
//   node deploy/coding-worker/test/p3-package.mjs --folder <new directory> --folder-program <built qorpera-folder>
//     qorpera-folder the folder program (scripts/build-folder-program.mjs), which the executor pushes into each machine
//     agent.mjs      the coding guest agent (scripts/package-coding-guest-agent.mjs), which it pushes there too
//     service/       the node's folder service package (scripts/package-folder-service.mjs), run as
//                    service/install-folder-service.sh
//   and prints one JSON line with the program's and the agent's sha256.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const args = process.argv.slice(2);
const folder = args.length === 4 && args[0] === "--folder" && args[2] === "--folder-program";
if (!folder && (args.length !== 2 || args[0] !== "--out"))
	throw new Error("Usage: p3-package.mjs --out <new-directory> | --folder <new-directory> --folder-program <program>");
const output = resolve(args[1]);
await mkdir(output, { recursive: false, mode: 0o755 });
if (folder) {
	const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
	// Each packager prints one JSON line last.
	const run = (script, ...rest) => {
		const printed = execFileSync(process.execPath, [script, ...rest], { stdio: ["ignore", "pipe", "inherit"] });
		return JSON.parse(printed.toString("utf8").trim().split("\n").at(-1));
	};
	const program = join(output, "qorpera-folder");
	await copyFile(resolve(args[3]), program);
	await chmod(program, 0o755);
	// The executor reads the agent alone, not its package's manifest.
	const agent = run("scripts/package-coding-guest-agent.mjs", "--out", join(output, "agent-package"));
	await rename(join(output, "agent-package", "agent.mjs"), join(output, "agent.mjs"));
	await rm(join(output, "agent-package"), { recursive: true });
	run("scripts/package-folder-service.mjs", "--out", join(output, "service"), "--folder-program", program);
	const programSha256 = sha256(await readFile(program));
	if (sha256(await readFile(join(output, "agent.mjs"))) !== agent.agentSha256 ||
		sha256(await readFile(join(output, "service", "qorpera-folder"))) !== programSha256)
		throw new Error("the folder pieces are not the ones just built");
	console.log(JSON.stringify({ output, programSha256, agentSha256: agent.agentSha256 }));
} else {
	execFileSync(process.execPath, ["scripts/package-coding-guest.mjs", "--out", resolve(output, "guest")], { stdio: ["ignore", "ignore", "inherit"] });
	await mkdir(resolve(output, "p3"), { mode: 0o755 });
	// The object gateway's dependencies require node's modules: its own packager's banner
	// (scripts/package-object-gateway.mjs).
	const require = 'import { createRequire as __qorperaCreateRequire } from "node:module"; const require = __qorperaCreateRequire(import.meta.url);';
	for (const [entry, file, banner] of [
		["deploy/coding-worker/test/p3-executor.ts", "p3-executor.mjs"],
		["packages/runtime/src/cloud-coding-command-http.ts", "p3-gateway.mjs"],
		["deploy/coding-worker/test/p3-objects.ts", "p3-objects.mjs", require],
	]) {
		await build({ entryPoints: [entry], outfile: resolve(output, "p3", file), ...(banner ? { banner: { js: banner } } : {}),
			bundle: true, platform: "node", format: "esm", target: "node22.19", legalComments: "none", logLevel: "warning" });
	}
	console.log(output);
}
