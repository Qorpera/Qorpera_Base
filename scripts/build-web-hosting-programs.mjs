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
	{ name: "qorpera-web-router", dir: "crates/qorpera-web-router", bin: "qorpera-web-router", staticLink: false },
	{ name: "qorpera-app-host", dir: "crates/qorpera-app-host", bin: "qorpera-app-host", staticLink: false },
	{ name: "qorpera-oci-init", dir: "crates/qorpera-app-host", bin: "qorpera-oci-init", staticLink: true },
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const records = {};

for (const crate of CRATES) {
	const work = mkdtempSync(join(tmpdir(), `${crate.name}-build-`));
	try {
		const buildEnvArgs = crate.staticLink
			? ["-e", "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS=-C target-feature=+crt-static"]
			: [];
		const targetArgs = crate.staticLink ? "--target x86_64-unknown-linux-gnu" : "";
		const builtBin = crate.staticLink
			? `/tmp/target/x86_64-unknown-linux-gnu/release/${crate.bin}`
			: `/tmp/target/release/${crate.bin}`;
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
				...buildEnvArgs,
				"-w",
				"/src",
				RUST_IMAGE,
				"sh",
				"-c",
				`cargo build --locked --release ${targetArgs} --bin ${crate.bin} && install -m 0755 ${builtBin} /out/${crate.name}`,
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
