import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUST_IMAGE } from "./run-on-node-plan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out-dir" || !args[1]) {
	throw new Error("Usage: node scripts/build-web-hosting-programs.mjs --out-dir <directory>");
}

const outDir = resolve(args[1]);
mkdirSync(outDir, { recursive: true });

const CRATES = [
	{ name: "qorpera-web-router", dir: "crates/qorpera-web-router" },
	{ name: "qorpera-app-host", dir: "crates/qorpera-app-host" },
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const records = {};

for (const crate of CRATES) {
	const work = mkdtempSync(join(tmpdir(), `${crate.name}-build-`));
	try {
		const built = spawnSync(
			"docker",
			[
				"run",
				"--rm",
				"-v",
				`${join(root, crate.dir)}:/src:ro`,
				"-v",
				`${work}:/out`,
				"-e",
				"CARGO_TARGET_DIR=/tmp/target",
				"-w",
				"/src",
				RUST_IMAGE,
				"sh",
				"-c",
				`cargo build --locked --release && install -m 0755 /tmp/target/release/${crate.name} /out/${crate.name}`,
			],
			{ stdio: "inherit" },
		);
		if (built.status !== 0) {
			throw new Error(`cargo build failed for ${crate.name} (${built.status})`);
		}
		const srcPath = join(work, crate.name);
		const dstPath = join(outDir, crate.name);
		const bytes = readFileSync(srcPath);
		const installed = spawnSync("install", ["-m", "0755", srcPath, dstPath], { stdio: "inherit" });
		if (installed.error || installed.status !== 0) {
			throw new Error(`install to ${dstPath} failed (${installed.error?.message ?? installed.status})`);
		}
		if (!readFileSync(dstPath).equals(bytes)) {
			throw new Error(`${dstPath} does not match built bytes`);
		}
		records[crate.name] = {
			image: RUST_IMAGE,
			target: "x86_64-unknown-linux-gnu",
			profile: "release",
			bytes: bytes.byteLength,
			sha256: sha256(bytes),
		};
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

console.log(JSON.stringify({ schema: "qorpera.web-hosting-programs/v1", programs: records }, null, 2));
