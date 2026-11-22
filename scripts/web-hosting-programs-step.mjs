import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RUST_IMAGE } from "./run-on-node-plan.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const WEB_HOSTING_CRATES = ["crates/qorpera-web-router", "crates/qorpera-app-host"];

function run(docker, args) {
	return new Promise((done) => {
		const child = spawn(docker, args, { stdio: "inherit" });
		child.on("error", () => done(127));
		child.on("exit", (code) => done(code ?? 1));
	});
}

export async function webHostingProgramsStep({ root = repository, docker = "docker" } = {}) {
	for (const crate of WEB_HOSTING_CRATES) {
		const started = Date.now();
		console.log(`== web-hosting-programs: testing ${crate}`);
		const code = await run(docker, [
			"run",
			"--rm",
			"-e",
			"CARGO_TARGET_DIR=/tmp/target",
			"-v",
			"qorpera-cargo-registry:/usr/local/cargo/registry",
			"-v",
			`${join(root, crate)}:/src:ro`,
			"-w",
			"/src",
			RUST_IMAGE,
			"sh",
			"-c",
			"cargo test --locked",
		]);
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		if (code !== 0) {
			console.log(`== web-hosting-programs: ${crate} FAILED (${code}) after ${seconds} s`);
			return false;
		}
		console.log(`== web-hosting-programs: ${crate} passed in ${seconds} s`);
	}
	return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = (await webHostingProgramsStep()) ? 0 : 1;
}
