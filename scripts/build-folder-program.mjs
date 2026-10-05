import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CARGO_BUILD, recordFor } from "./folder-program-artifact.mjs";
import { RUST_IMAGE } from "./run-on-node-plan.mjs";

/** Builds crates/qorpera-folder for x86-64 Linux in the pinned Rust image (the one its tests run in), with the
 * locked crates, writes the program to --out and prints its build record (scripts/folder-program-artifact.mjs). The
 * same source and image give the same bytes, so the coordinator can build it again at a cut and compare. Needs Docker (the node 2 test machine or the build
 * space); nothing is left in the source tree. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1])
	throw new Error("Usage: node scripts/build-folder-program.mjs --out <file>");
const out = resolve(args[1]);
const work = mkdtempSync(join(tmpdir(), "qorpera-folder-build-"));
try {
	const built = spawnSync(
		"docker",
		[
			"run",
			"--rm",
			"-v",
			`${join(root, "crates/qorpera-folder")}:/src:ro`,
			"-v",
			`${work}:/out`,
			"-e",
			"CARGO_TARGET_DIR=/tmp/target",
			"-w",
			"/src",
			RUST_IMAGE,
			"sh",
			"-c",
			`${CARGO_BUILD} && install -m 0755 /tmp/target/release/qorpera-folder /out/qorpera-folder`,
		],
		{ stdio: "inherit" },
	);
	if (built.status !== 0) throw new Error(`cargo build failed (${built.status})`);
	const bytes = readFileSync(join(work, "qorpera-folder"));
	const installed = spawnSync("install", ["-m", "0755", join(work, "qorpera-folder"), out], { stdio: "inherit" });
	if (installed.error || installed.status !== 0)
		throw new Error(`install to ${out} failed (${installed.error?.message ?? installed.status})`);
	// The program at the destination is the one just built.
	if (!readFileSync(out).equals(bytes)) throw new Error(`${out} does not hold the program just built`);
	// The record to commit as deploy/folder-service/folder-program-linux-x64.json when the source changed.
	console.log(JSON.stringify(recordFor(bytes, RUST_IMAGE), null, 2));
} finally {
	rmSync(work, { recursive: true, force: true });
}
