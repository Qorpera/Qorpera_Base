import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUST_IMAGE } from "./run-on-node-plan.mjs";

/** Builds crates/qorpera-folder for x86-64 Linux in the pinned Rust image (the one its tests run in), with the
 * locked crates, and writes the program to --out. The same source and image give the same bytes, so the coordinator
 * can build it again at a cut and compare the sha256 printed here. Needs Docker (the node 2 test machine or the build
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
			"cargo build --locked --release && install -m 0755 /tmp/target/release/qorpera-folder /out/qorpera-folder",
		],
		{ stdio: "inherit" },
	);
	if (built.status !== 0) throw new Error(`cargo build failed (${built.status})`);
	const bytes = readFileSync(join(work, "qorpera-folder"));
	const installed = spawnSync("install", ["-m", "0755", join(work, "qorpera-folder"), out], { stdio: "inherit" });
	if (installed.error || installed.status !== 0)
		throw new Error(`install to ${out} failed (${installed.error?.message ?? installed.status})`);
	// The program at the destination is the one just built.
	if (createHash("sha256").update(readFileSync(out)).digest("hex") !== createHash("sha256").update(bytes).digest("hex"))
		throw new Error(`${out} does not hold the program just built`);
	console.log(
		JSON.stringify({ out, image: RUST_IMAGE, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }),
	);
} finally {
	rmSync(work, { recursive: true, force: true });
}
