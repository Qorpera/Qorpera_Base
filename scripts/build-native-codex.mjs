import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const patchRoot = join(repository, "deploy/first-node/native-codex");
const usage = "Usage: node scripts/build-native-codex.mjs --source <pinned upstream clone> --out <new directory> [--profile dev|release] [--jobs 1..16] [--target-cache <absolute directory>] [--prepare-only]";

/** The upstream release tag bumps workspace versions but leaves these path packages at 0.0.0. */
export function normalizeNativeCargoLock(source, version) {
	if (typeof source !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid lock normalization input");
	let packages = 0;
	const lock = source.split("[[package]]").map((block, index) => {
		if (index === 0 || /^source = /m.test(block)) return block;
		if (!/^name = "[^"\n]+"$/m.test(block) || !/^version = "0\.0\.0"$/m.test(block))
			throw new Error("Unexpected upstream path package version");
		packages++;
		return block.replace(/^version = "0\.0\.0"$/m, `version = "${version}"`);
	}).join("[[package]]");
	return { lock, packages };
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
	return result.stdout?.trim();
}

async function digestFile(path) {
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(path)) digest.update(chunk);
	return digest.digest("hex");
}

/** Strip only the staged copy, using LLVM shipped with the pinned Rust
 * toolchain. Retain the input/tool digests so packaging never substitutes an
 * arbitrary host strip command or silently changes the Cargo build profile. */
export async function stripNativeCodexDebug(binary, rustc, target, toolchain, execute = run) {
	if (!isAbsolute(binary) || !isAbsolute(rustc) || !/^[a-z0-9_-]{8,80}$/.test(target) || !/^\d+\.\d+\.\d+$/.test(toolchain))
		throw new Error("Invalid native release processing input");
	const compiler = execute(rustc, ["-vV"], { stdio: "pipe" });
	if (!compiler?.startsWith(`rustc ${toolchain} `) || !compiler.split("\n").includes(`host: ${target}`))
		throw new Error("Native release processing requires the pinned compiler");
	const sysroot = execute(rustc, ["--print", "sysroot"], { stdio: "pipe" });
	if (!sysroot || !isAbsolute(sysroot)) throw new Error("Pinned Rust sysroot is missing");
	const tool = join(sysroot, "lib", "rustlib", target, "bin", "llvm-objcopy");
	for (const path of [binary, tool]) {
		const entry = await lstat(path);
		if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1)
			throw new Error("Native release processing requires physical files");
	}
	const inputSha256 = await digestFile(binary);
	const toolSha256 = await digestFile(tool);
	execute(tool, ["--strip-debug", binary]);
	return { tool: "rust-llvm-objcopy", toolchain, operation: "strip-debug", inputSha256, toolSha256 };
}

async function main(args) {
	if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
	const options = { profile: "release", jobs: 4, prepareOnly: false };
	const seen = new Set();
	for (let index = 0; index < args.length; index++) {
		const flag = args[index];
		if (seen.has(flag)) throw new Error(usage);
		seen.add(flag);
		if (flag === "--prepare-only") options.prepareOnly = true;
		else if (["--source", "--out", "--profile", "--jobs", "--target-cache"].includes(flag) && args[index + 1]) {
			const value = args[++index];
			options[flag.slice(2)] = flag === "--jobs" ? Number(value) : value;
		} else throw new Error(usage);
	}
	if (!options.source || !options.out || !isAbsolute(options.source) || !isAbsolute(options.out) ||
		(options["target-cache"] !== undefined && (!isAbsolute(options["target-cache"]) ||
			resolve(options["target-cache"]) === resolve(options.source) || resolve(options["target-cache"]) === resolve(options.out))) ||
		!["dev", "release"].includes(options.profile) || !Number.isInteger(options.jobs) || options.jobs < 1 || options.jobs > 16 ||
		process.platform === "win32") throw new Error(usage);
	const contract = JSON.parse(await readFile(join(patchRoot, "source.json"), "utf8"));
	const patch = await readFile(join(patchRoot, "0001-cloud-result-fence.patch"));
	if (createHash("sha256").update(patch).digest("hex") !== contract.patchSha256)
		throw new Error("Native patch digest mismatch");
	const upstream = run("git", ["-C", options.source, "rev-parse", `${contract.commit}^{commit}`], { stdio: "pipe" });
	if (upstream !== contract.commit) throw new Error("Pinned upstream commit is unavailable");
	// Never alter the supplied checkout, reuse an output directory, or remove a failed build.
	await mkdir(options.out, { mode: 0o700 });
	const source = join(options.out, "source");
	run("git", ["clone", "--no-local", "--no-checkout", "--", options.source, source]);
	run("git", ["-c", "core.hooksPath=/dev/null", "-C", source, "checkout", "--detach", contract.commit]);
	const lockPath = join(source, "codex-rs/Cargo.lock");
	const original = await readFile(lockPath, "utf8");
	if (createHash("sha256").update(original).digest("hex") !== contract.cargoLock.upstreamSha256)
		throw new Error("Upstream Cargo lock digest mismatch");
	const normalized = normalizeNativeCargoLock(original, contract.version);
	if (normalized.packages !== contract.cargoLock.pathPackages ||
		createHash("sha256").update(normalized.lock).digest("hex") !== contract.cargoLock.normalizedSha256)
		throw new Error("Cargo lock normalization changed more than release metadata");
	await writeFile(lockPath, normalized.lock);
	run("git", ["-C", source, "apply", "--check", "--whitespace=error", "-"], { stdio: "pipe", input: patch });
	run("git", ["-C", source, "apply", "--whitespace=error", "-"], { stdio: "pipe", input: patch });
	await writeFile(join(options.out, "prepared.json"), `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx" });
	if (options.prepareOnly) { console.log(source); return; }
	// Resolve real toolchain executables: a local tool-manager shim may ignore RUSTUP_TOOLCHAIN.
	const cargo = run("rustup", ["which", "--toolchain", contract.rustToolchain, "cargo"], { stdio: "pipe" });
	const rustc = run("rustup", ["which", "--toolchain", contract.rustToolchain, "rustc"], { stdio: "pipe" });
	if (!cargo || !rustc || !isAbsolute(cargo) || !isAbsolute(rustc)) throw new Error("Pinned Rust executables are missing");
	const compiler = run(rustc, ["-vV"], { stdio: "pipe" });
	if (!compiler?.startsWith(`rustc ${contract.rustToolchain} `)) throw new Error("Pinned Rust toolchain is required");
	const target = compiler.match(/^host: (\S+)$/m)?.[1];
	if (!target) throw new Error("Rust target is missing");
	// Reuse only compiler intermediates; source, patch application, final artifact
	// and evidence still get a fresh output directory and exact digest checks.
	const targetRoot = options["target-cache"] ?? join(options.out, "target");
	run(cargo, ["build", "--locked", "-j", String(options.jobs),
		"-p", "codex-cli", "--bin", "codex", ...(options.profile === "release" ? ["--release"] : [])], {
		cwd: join(source, "codex-rs"),
		env: { ...process.env, PATH: `${dirname(cargo)}:${process.env.PATH ?? "/usr/bin:/bin"}`, RUSTC: rustc,
			RUSTUP_TOOLCHAIN: contract.rustToolchain, CARGO_TARGET_DIR: targetRoot, CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
	});
	const binary = join(options.out, "codex");
	await copyFile(join(targetRoot, options.profile === "release" ? "release" : "debug", "codex"), binary, constants.COPYFILE_EXCL);
	const processing = options.profile === "release" ? await stripNativeCodexDebug(binary, rustc, target, contract.rustToolchain) : null;
	await chmod(binary, 0o555);
	const artifact = { schema: "qorpera.native-codex-artifact/v1", source: contract,
		artifact: { file: "codex", bytes: (await stat(binary)).size, sha256: await digestFile(binary), target,
			profile: options.profile, compiler, processing }, cloudAcceptance: "not_performed" };
	await copyFile(join(source, "LICENSE"), join(options.out, "LICENSE"), constants.COPYFILE_EXCL);
	await copyFile(join(source, "NOTICE"), join(options.out, "NOTICE"), constants.COPYFILE_EXCL);
	await writeFile(join(options.out, "artifact.json"), `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
	console.log(binary);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { await main(process.argv.slice(2)); }
	catch (error) { console.error(error instanceof Error ? error.message : "Native build failed"); process.exitCode = 1; }
}
