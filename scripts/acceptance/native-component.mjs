import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, ftruncateSync, openSync, writeSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, statfs, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { availableParallelism, totalmem } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startCloudNativeResultFence } from "../../packages/runtime/src/cloud-native-result-fence.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execute = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cases = new Map([
	["patched-codex-boundary.test.ts", 6],
	["native-codex-capture-images.test.ts", 9],
	["native-codex-compaction.test.ts", 4],
]);

export function nativeComponentOptions(args) {
	const options = {};
	for (let index = 0; index < args.length; index += 2) {
		const key = { "--source": "source", "--out": "out" }[args[index]], value = args[index + 1];
		assert(key && !options[key] && typeof value === "string" && isAbsolute(value) && resolve(value) === value && value !== "/" && !/[\x00-\x20\x7f]/.test(value), "Exact source/output paths required");
		options[key] = value;
	}
	assert(options.source && options.out, "Require --source and --out");
	for (const source of [repository, options.source])
		assert(options.out !== source && !options.out.startsWith(`${source}/`) && !source.startsWith(`${options.out}/`), "Output must be separate from source");
	return options;
}

export function nativeV8Plan(cargo, trustedChecksums) {
	const versions = [...cargo.matchAll(/^v8 = "=(\d+\.\d+\.\d+)"$/gm)];
	assert.equal(versions.length, 1, "Require one exact upstream V8 version");
	const version = versions[0][1], suffix = "ptrcomp_sandbox_release_x86_64-unknown-linux-gnu";
	const manifest = `rusty_v8_${suffix}.sha256`;
	const rows = trustedChecksums.trim().split(/\r?\n/).map((line) => line.split(/ {2}/));
	const pins = rows.filter((row) => row[1] === manifest);
	assert(pins.length === 1 && /^[a-f0-9]{64}$/.test(pins[0][0]), "Require one trusted V8 manifest hash");
	return { version, manifest, manifestSha256: pins[0][0], archive: `librusty_v8_${suffix}.a.gz`, binding: `src_binding_${suffix}.rs`, baseUrl: `https://github.com/openai/codex/releases/download/rusty-v8-v${version}` };
}

export function verifyNativeV8Manifest(plan, bytes) {
	assert.equal(sha256(bytes), plan.manifestSha256, "V8 manifest digest mismatch");
	const rows = bytes.toString().trim().split(/\r?\n/).map((line) => line.split(/ {2}/));
	assert.equal(rows.length, 2, "Require exactly two V8 inputs");
	assert.deepEqual(rows.map((row) => row[1]).sort(), [plan.archive, plan.binding].sort(), "Unexpected or duplicate V8 input");
	assert(rows.every((row) => row.length === 2 && /^[a-f0-9]{64}$/.test(row[0])), "Invalid V8 checksum");
	return rows.map(([sha256, file]) => ({ file, sha256 }));
}

export function verifyNativeComponentTests(report, root = repository) {
	assert.equal(report.success, true, "Native component report did not succeed");
	for (const key of ["numFailedTests", "numPendingTests", "numTodoTests", "numFailedTestSuites", "numPendingTestSuites"])
		assert.equal(report[key], 0, `Native component ${key} must be zero`);
	assert.equal(report.numTotalTests, 19);
	assert.equal(report.numPassedTests, 19);
	assert.equal(report.testResults?.length, 3);
	const expected = new Map([...cases].map(([name, count]) => [join(root, "packages/runtime/test", name), count]));
	for (const file of report.testResults) {
		const count = expected.get(file.name);
		assert(count, "Unexpected or duplicate native test file");
		expected.delete(file.name);
		assert.equal(file.status, "passed");
		assert.equal(file.message, "");
		assert.equal(file.assertionResults?.length, count);
		for (const test of file.assertionResults) {
			assert.equal(test.status, "passed", "Every native assertion must execute and pass");
			assert.deepEqual(test.failureMessages, []);
		}
	}
	assert.equal(expected.size, 0);
	return { passed: 19, skipped: 0, failed: 0, files: 3 };
}

export function nativeComponentEnvironment(root, path, binary) {
	assert(isAbsolute(root) && typeof path === "string" && path.length > 0);
	return { PATH: path, HOME: join(root, "home"), TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), LANG: "C", LC_ALL: "C", TZ: "UTC", CI: "true", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", AWS_EC2_METADATA_DISABLED: "true", ...(binary ? { QORPERA_CODEX_FENCE_BINARY: binary } : {}) };
}

/** Exercise the production socket guard at the exact per-session directory depth. */
export async function verifyNativeComponentTestSocket(tempDirectory) {
	const allocation = await mkdtemp(join(tempDirectory, "qorpera-codex-boundary-"));
	let service;
	try {
		const root = join(allocation, "runtime");
		await mkdir(root, { mode: 0o700 });
		service = await startCloudNativeResultFence({ root, boundary: { close() {}, async fenceNativeResults() { return []; } }, assertSession() {}, onFailure() {}, signal: new AbortController().signal });
		assert.equal((await lstat(service.path)).mode & 0o777, 0o600);
		await new Promise((resolve, reject) => {
			const socket = createConnection(service.path);
			socket.setTimeout(5000, () => socket.destroy(new Error("Native component socket preflight timed out")));
			socket.once("error", reject);
			socket.once("connect", () => { socket.destroy(); resolve(); });
		});
		return { socketBytes: Buffer.byteLength(service.path), privateDirectory: true, socketMode: "0600", bindConnectPassed: true };
	} finally {
		try { await service?.close(); }
		finally { await rm(allocation, { recursive: true, force: true }); }
	}
}

/** The build/evidence path may be long; native Unix IPC needs a separate short private home. */
export async function withNativeComponentTestIsolation(evidence, run) {
	const root = await mkdtemp(join(await realpath("/tmp"), "qnc-"));
	evidence.root = root;
	evidence.removed = false;
	let operationError;
	try {
		assert.equal((await lstat(root)).mode & 0o777, 0o700);
		for (const part of ["home", "tmp", "config", "cache"]) await mkdir(join(root, part), { mode: 0o700 });
		evidence.socketPreflight = await verifyNativeComponentTestSocket(join(root, "tmp"));
		return await run(root);
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		try {
			await rm(root, { recursive: true, force: true });
			await lstat(root).then(() => { throw new Error("Native component test isolation remains after cleanup"); }, (error) => { if (error.code !== "ENOENT") throw error; });
			evidence.removed = true;
		} catch (error) {
			evidence.cleanupError = error instanceof Error ? error.message : String(error);
			if (operationError) throw new AggregateError([operationError, error], "Native component operation and isolation cleanup both failed");
			throw error;
		}
	}
}

async function digestFile(path) {
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(path)) hash.update(bytes);
	return hash.digest("hex");
}

export async function verifyNativeComponentArtifact(directory, contract) {
	const manifest = JSON.parse(await readFile(join(directory, "artifact.json"), "utf8"));
	assert.equal(manifest.schema, "qorpera.native-codex-artifact/v1");
	assert.deepEqual(manifest.source, contract, "Component source provenance differs from reviewed input");
	assert.equal(manifest.artifact?.file, "codex");
	assert.equal(manifest.artifact.profile, "dev", "Only separately labeled dev component builds accepted");
	assert.equal(manifest.artifact.target, "x86_64-unknown-linux-gnu");
	assert.equal(manifest.artifact.processing, null);
	assert.equal(manifest.cloudAcceptance, "not_performed");
	assert(manifest.artifact.compiler.startsWith(`rustc ${contract.rustToolchain} `));
	const binary = join(directory, "codex"), info = await lstat(binary);
	assert(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o222) === 0 && (await realpath(binary)) === binary, "Require a physical read-only component executable");
	assert.equal(info.size, manifest.artifact.bytes);
	assert.equal(await digestFile(binary), manifest.artifact.sha256, "Component executable digest mismatch");
	return manifest;
}

async function artifactFiles(directory) {
	const files = [];
	for (const file of ["codex", "artifact.json", "LICENSE", "NOTICE"]) {
		const path = join(directory, file), info = await lstat(path);
		assert(info.isFile() && !info.isSymbolicLink() && (await realpath(path)) === path, "Only physical component artifact files may be retained");
		files.push({ file, bytes: info.size, sha256: await digestFile(path) });
	}
	return files;
}

/** Prefix and live tail are persisted even if the build or driver is killed. */
export async function runNativeComponentCommand(command, args, { cwd, env, log, timeoutMs, killGraceMs = 5000, prefixBytes = 4 * 1024 * 1024, tailBytes = 128 * 1024 }) {
	assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
	const prefix = openSync(`${log}.log`, "wx", 0o600), tail = openSync(`${log}-tail.log`, "wx", 0o600);
	let written = 0, total = 0, retained = Buffer.alloc(0), timedOut = false, spawnError = null, killTimer;
	const started = Date.now();
	try {
		const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const consume = (bytes) => {
			total += bytes.length;
			const count = Math.min(bytes.length, Math.max(0, prefixBytes - written));
			if (count) { writeSync(prefix, bytes, 0, count); written += count; }
			retained = Buffer.concat([retained, bytes]).subarray(-tailBytes);
			ftruncateSync(tail, 0);
			writeSync(tail, retained, 0, retained.length, 0);
		};
		child.stdout.on("data", consume);
		child.stderr.on("data", consume);
		const kill = (signal) => {
			if (!child.pid) return;
			try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill("SIGTERM");
			killTimer = setTimeout(() => kill("SIGKILL"), killGraceMs);
		}, timeoutMs);
		const result = await new Promise((resolve) => {
			child.once("error", (error) => { spawnError = error.message; });
			child.once("close", (code, signal) => resolve({ code, signal }));
		});
		clearTimeout(timer);
		clearTimeout(killTimer);
		// A command may exit while a detached descendant has closed its pipes.
		kill("SIGKILL");
		return { ...result, spawnError, timedOut, elapsedMs: Date.now() - started, outputBytes: total, prefixBytes: written, tailBytes: retained.length, omittedMiddleBytes: Math.max(0, total - written - retained.length) };
	} finally { closeSync(prefix); closeSync(tail); }
}

async function snapshot(directory) {
	const disk = await statfs(directory);
	return { observedAt: new Date().toISOString(), availableCpus: availableParallelism(), physicalMemoryBytes: totalmem(), freeDiskBytes: disk.bavail * disk.bsize, meminfo: await readFile("/proc/meminfo", "utf8"), cgroupMemoryCurrent: await readFile("/sys/fs/cgroup/memory.current", "utf8").catch(() => null), cgroupMemoryMax: await readFile("/sys/fs/cgroup/memory.max", "utf8").catch(() => null), cgroupMemoryPeak: await readFile("/sys/fs/cgroup/memory.peak", "utf8").catch(() => null), cgroupMemoryEvents: await readFile("/sys/fs/cgroup/memory.events", "utf8").catch(() => null) };
}

async function download(url, path, limit) {
	const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	assert(response.ok && response.body, `V8 dependency download failed (${response.status})`);
	const chunks = [];
	let size = 0;
	for await (const bytes of response.body) {
		size += bytes.length;
		assert(size <= limit, "V8 dependency exceeded its bounded download size");
		chunks.push(bytes);
	}
	const bytes = Buffer.concat(chunks);
	await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
	return bytes;
}

export async function runNativeComponentAcceptance(options) {
	assert(process.platform === "linux" && process.arch === "x64" && process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted", "Require disposable GitHub-hosted Linux x64");
	assert(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? ""), "Require recorded candidate commit");
	for (const path of [repository, options.source, dirname(options.out)]) assert.equal(await realpath(path), path);
	await mkdir(options.out, { mode: 0o700 });
	const evidence = { schema: "qorpera.native-component-acceptance/v1", candidateCommit: process.env.GITHUB_SHA, passed: false, stage: "initializing", startedAt: new Date().toISOString(), profile: "dev", buildJobs: 1, releaseArtifact: false, retainedReleaseBinaryExercised: false, resourceScope: "Host/cgroup snapshots include runner services; GNU time reports the build command's resource accounting. A killed driver retains the last incomplete checkpoint and live bounded logs, never a success claim.", scope: "Freshly built, separately hashed pinned-source component binary against scripted loopback providers. No real model, joined founding, deployment, signing or release artifact proof." };
	const save = async () => {
		await writeFile(join(options.out, "evidence.json.tmp"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
		await rename(join(options.out, "evidence.json.tmp"), join(options.out, "evidence.json"));
	};
	try {
		await save();
		evidence.hostBefore = await snapshot(options.out);
		const contract = JSON.parse(await readFile(join(repository, "deploy/first-node/native-codex/source.json"), "utf8"));
		assert.equal(contract.repository, "https://github.com/openai/codex.git");
		const git = async (directory, args) => (await execute("git", ["-C", directory, ...args], { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
		assert.equal(await git(repository, ["rev-parse", "HEAD"]), evidence.candidateCommit);
		assert.equal(await git(repository, ["status", "--porcelain", "--untracked-files=no"]), "", "Candidate tracked source must be clean");
		assert.equal(await git(options.source, ["rev-parse", "HEAD"]), contract.commit);
		assert.equal(await git(options.source, ["status", "--porcelain", "--untracked-files=no"]), "", "Upstream checkout must be clean");
		assert.equal(await digestFile(join(repository, "deploy/first-node/native-codex/0001-cloud-result-fence.patch")), contract.patchSha256);
		evidence.source = contract;
		evidence.inputSha256 = {};
		for (const path of ["scripts/build-native-codex.mjs", "deploy/first-node/native-codex/source.json", "deploy/first-node/native-codex/0001-cloud-result-fence.patch", ...[...cases.keys()].map((file) => `packages/runtime/test/${file}`)]) evidence.inputSha256[path] = await digestFile(join(repository, path));
		const cargo = await readFile(join(options.source, "codex-rs/Cargo.toml"), "utf8"), version = /^v8 = "=(\d+\.\d+\.\d+)"$/m.exec(cargo)?.[1];
		assert(version, "Pinned upstream V8 dependency missing");
		const plan = nativeV8Plan(cargo, await readFile(join(options.source, `third_party/v8/rusty_v8_${version.replaceAll(".", "_")}_release_manifests.sha256`), "utf8"));
		const v8 = join(options.out, "v8");
		await mkdir(v8);
		evidence.stage = "fetching-verified-v8";
		await save();
		const pins = verifyNativeV8Manifest(plan, await download(`${plan.baseUrl}/${plan.manifest}`, join(v8, plan.manifest), 4096));
		for (const pin of pins) {
			const bytes = await download(`${plan.baseUrl}/${pin.file}`, join(v8, pin.file), pin.file === plan.archive ? 64 * 1024 * 1024 : 1024 * 1024);
			assert.equal(sha256(bytes), pin.sha256, "V8 input digest mismatch");
			pin.bytes = bytes.length;
		}
		evidence.v8 = { ...plan, inputs: pins };
		const isolated = join(options.out, "isolation");
		for (const path of [isolated, ...["home", "tmp", "config", "cache", "cargo"].map((part) => join(isolated, part))]) await mkdir(path, { mode: 0o700 });
		const env = nativeComponentEnvironment(isolated, process.env.PATH);
		assert(isAbsolute(process.env.RUSTUP_HOME ?? ""), "Require explicit Rust toolchain home");
		const buildEnv = { ...env, RUSTUP_HOME: process.env.RUSTUP_HOME, CARGO_HOME: join(isolated, "cargo"), CARGO_NET_GIT_FETCH_WITH_CLI: "true", RUSTY_V8_ARCHIVE: join(v8, plan.archive), RUSTY_V8_SRC_BINDING_PATH: join(v8, plan.binding) };
		evidence.stage = "building";
		await save();
		evidence.build = await runNativeComponentCommand("/usr/bin/time", ["-v", "-o", join(options.out, "build-resources.log"), process.execPath, join(repository, "scripts/build-native-codex.mjs"), "--source", options.source, "--out", join(options.out, "build"), "--profile", "dev", "--jobs", "1"], { cwd: repository, env: buildEnv, log: join(options.out, "build"), timeoutMs: 150 * 60_000 });
		evidence.hostAfterBuild = await snapshot(options.out);
		await save();
		assert(evidence.build.code === 0 && !evidence.build.timedOut && !evidence.build.spawnError, "Pinned native component build failed; retained build/resource logs describe the failure");
		evidence.artifact = await verifyNativeComponentArtifact(join(options.out, "build"), contract);
		evidence.retainedArtifactFiles = await artifactFiles(join(options.out, "build"));
		evidence.stage = "test-isolation-preflight";
		evidence.testIsolation = {};
		await save();
		const binary = join(options.out, "build/codex"), reportPath = join(options.out, "vitest.json");
		await withNativeComponentTestIsolation(evidence.testIsolation, async (testRoot) => {
			evidence.stage = "testing";
			await save();
			evidence.execution = await runNativeComponentCommand(process.execPath, [join(repository, "node_modules/vitest/dist/cli.js"), "--run", "--maxWorkers=1", "--no-file-parallelism", "--no-cache", "--reporter=default", "--reporter=json", `--outputFile=${reportPath}`, ...[...cases.keys()].map((file) => `test/${file}`)], { cwd: join(repository, "packages/runtime"), env: nativeComponentEnvironment(testRoot, process.env.PATH, binary), log: join(options.out, "tests"), timeoutMs: 15 * 60_000 });
		});
		await save();
		assert(evidence.execution.code === 0 && !evidence.execution.timedOut && !evidence.execution.spawnError, "Native component tests failed; retained test logs describe the failure");
		evidence.tests = verifyNativeComponentTests(JSON.parse(await readFile(reportPath, "utf8")));
		assert.deepEqual(await verifyNativeComponentArtifact(join(options.out, "build"), contract), evidence.artifact, "Component executable changed during tests");
		assert.deepEqual(await artifactFiles(join(options.out, "build")), evidence.retainedArtifactFiles, "Retained component files changed during tests");
		evidence.retainedArtifactFilesVerifiedAfterTests = true;
		for (const [path, digest] of Object.entries(evidence.inputSha256)) assert.equal(await digestFile(join(repository, path)), digest, `Reviewed native input changed during tests: ${path}`);
		evidence.artifactAndInputHashesUnchanged = true;
		assert.equal(await git(repository, ["rev-parse", "HEAD"]), evidence.candidateCommit);
		assert.equal(await git(repository, ["status", "--porcelain", "--untracked-files=no"]), "", "Candidate tracked source changed during acceptance");
		evidence.trackedSourceUnchanged = true;
		evidence.passed = true;
		evidence.stage = "complete";
	} catch (error) {
		evidence.failure = { stage: evidence.stage, message: error instanceof Error ? error.message : String(error) };
		throw error;
	} finally {
		evidence.finishedAt = new Date().toISOString();
		evidence.hostAfter = await snapshot(options.out).catch(() => null);
		await save();
	}
	return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const proof = await runNativeComponentAcceptance(nativeComponentOptions(process.argv.slice(2)));
		console.log(JSON.stringify({ passed: proof.passed, componentSha256: proof.artifact.artifact.sha256, tests: proof.tests, releaseArtifact: false }));
	} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
