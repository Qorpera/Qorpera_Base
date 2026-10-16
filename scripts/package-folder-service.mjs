import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Packages the node host's folder service (deploy/folder-service): the service bundle, the folder program built by
 * scripts/build-folder-program.mjs (here, the vsock bridge), the units, the installer and a manifest of every file's
 * sha256. The execution host gets the folder program and its mount unit from the shared-execution package. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: node scripts/package-folder-service.mjs --out <new-directory> --folder-program <built qorpera-folder>";
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--out" || args[2] !== "--folder-program" || !args[1] || !args[3]) throw new Error(USAGE);
const output = resolve(args[1]);
const program = resolve(args[3]);
// No overwrite: every package is a fresh directory.
await mkdir(output, { mode: 0o755 });
await build({
	absWorkingDir: root,
	entryPoints: { "qorpera-folder-service": "packages/object-gateway/src/folder-service/cli.ts" },
	outdir: output,
	outExtension: { ".js": ".cjs" },
	bundle: true,
	platform: "node",
	// CommonJS: under --jitless the ESM facade of node:http evaluates its WebSocket export, which needs WebAssembly.
	format: "cjs",
	target: "node22.19",
	legalComments: "none",
	logLevel: "silent",
});
const programBytes = await readFile(program);
// An ELF x86-64 executable, as built for the nodes and their machines.
if (programBytes.subarray(0, 4).toString("latin1") !== "\x7fELF" || programBytes.readUInt16LE(18) !== 62)
	throw new Error("--folder-program must be the x86-64 Linux build of crates/qorpera-folder");
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
for (const file of deployed) await copyFile(join(root, "deploy/folder-service", file), join(output, file));
await chmod(join(output, "install-folder-service.sh"), 0o755);
const artifacts = [];
for (const file of ["qorpera-folder-service.cjs", "qorpera-folder", ...deployed]) {
	const bytes = await readFile(join(output, file));
	artifacts.push({ file, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const manifest = { schema: "qorpera.folder-service-package/v1", runtime: { node: ">=22.19.0", platform: "linux-x64" }, artifacts };
await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ output, manifestSha256: createHash("sha256").update(`${JSON.stringify(manifest, null, 2)}\n`).digest("hex") }));
