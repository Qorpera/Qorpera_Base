import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	nativeComponentEnvironment,
	nativeComponentOptions,
	nativeV8Plan,
	runNativeComponentCommand,
	verifyNativeComponentArtifact,
	verifyNativeComponentTests,
	verifyNativeComponentTestSocket,
	verifyNativeV8Manifest,
	withNativeComponentTestIsolation,
} from "./native-component.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = "/fixture/repository";
const counts = [["patched-codex-boundary.test.ts", 7], ["native-codex-capture-images.test.ts", 9], ["native-codex-compaction.test.ts", 4]];
function passingReport() {
	return { success: true, numTotalTests: 20, numPassedTests: 20, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0, testResults: counts.map(([file, count]) => ({ name: join(root, "packages/runtime/test", file), status: "passed", message: "", assertionResults: Array.from({ length: count }, () => ({ status: "passed", failureMessages: [] })) })) };
}

test("only canonical, separate new output and exact source paths are accepted", () => {
	assert.deepEqual(nativeComponentOptions(["--source", "/fixture/upstream", "--out", "/fixture/output"]), { source: "/fixture/upstream", out: "/fixture/output" });
	for (const args of [[], ["--source", "/fixture/upstream"], ["--source", "/fixture/upstream", "--out", "/fixture/upstream/output"], ["--source", "/fixture/upstream", "--out", "/fixture"], ["--source", "/fixture/upstream", "--out", "relative"], ["--source", "/fixture/upstream", "--out", "/fixture/../output"], ["--source", "/fixture/upstream", "--out", "/fixture/output", "--profile", "release"]]) assert.throws(() => nativeComponentOptions(args));
});

test("V8 downloads require the exact pinned manifest and both closed input names", () => {
	const suffix = "ptrcomp_sandbox_release_x86_64-unknown-linux-gnu";
	const manifest = `rusty_v8_${suffix}.sha256`, archive = `librusty_v8_${suffix}.a.gz`, binding = `src_binding_${suffix}.rs`;
	const bytes = Buffer.from(`${digest("archive")}  ${archive}\n${digest("binding")}  ${binding}\n`);
	const plan = nativeV8Plan('v8 = "=150.4.0"\n', `${digest(bytes)}  ${manifest}\n`);
	assert.equal(plan.baseUrl, "https://github.com/openai/codex/releases/download/rusty-v8-v150.4.0");
	assert.deepEqual(verifyNativeV8Manifest(plan, bytes), [{ file: archive, sha256: digest("archive") }, { file: binding, sha256: digest("binding") }]);
	assert.throws(() => verifyNativeV8Manifest(plan, Buffer.concat([bytes, Buffer.from("tamper")])), /digest mismatch/);
	for (const value of [bytes.toString().replace(binding, archive), bytes.toString().replace(binding, "../foreign"), `${bytes}${digest("extra")}  unexpected\n`]) assert.throws(() => verifyNativeV8Manifest({ ...plan, manifestSha256: digest(value) }, Buffer.from(value)));
	assert.throws(() => nativeV8Plan('v8 = "150.4.0"\n', `${digest(bytes)}  ${manifest}\n`));
	assert.throws(() => nativeV8Plan('v8 = "=150.4.0"\n', `${digest(bytes)}  ${manifest}\n${digest(bytes)}  ${manifest}\n`));
});

test("all 20 actual assertions in the three exact files must pass", () => {
	assert.deepEqual(verifyNativeComponentTests(passingReport(), root), { passed: 20, skipped: 0, failed: 0, files: 3 });
	for (const key of ["numFailedTests", "numPendingTests", "numTodoTests", "numFailedTestSuites", "numPendingTestSuites"]) {
		const report = passingReport(); report[key] = 1;
		assert.throws(() => verifyNativeComponentTests(report, root));
	}
	for (const mutate of [
		(report) => { report.success = false; },
		(report) => { report.numTotalTests = 0; report.numPassedTests = 0; report.testResults = []; },
		(report) => { report.testResults[0].assertionResults[0].status = "skipped"; },
		(report) => { report.testResults[0].assertionResults[0].status = "todo"; },
		(report) => { report.testResults[0].assertionResults[0].failureMessages = ["unhandled"]; },
		(report) => { report.testResults[0].message = "suite startup failed"; },
		(report) => { report.testResults[0].name = report.testResults[1].name; },
		(report) => { report.testResults[0].assertionResults.pop(); },
		(report) => { report.testResults[0].name = "/foreign/patched-codex-boundary.test.ts"; },
	]) { const report = passingReport(); mutate(report); assert.throws(() => verifyNativeComponentTests(report, root)); }
});

test("the old 19-case report cannot omit the added Fast case or substitute another file's assertion", () => {
	const old = passingReport();
	old.numTotalTests = 19; old.numPassedTests = 19;
	old.testResults[0].assertionResults.pop();
	assert.throws(() => verifyNativeComponentTests(old, root));
	const shifted = passingReport();
	shifted.testResults[1].assertionResults.push(shifted.testResults[0].assertionResults.pop());
	assert.throws(() => verifyNativeComponentTests(shifted, root));
});

test("the test environment is closed and admits only the explicit component binary", () => {
	const env = nativeComponentEnvironment("/fixture/isolation", "/usr/bin", "/fixture/output/build/codex");
	assert.equal(env.QORPERA_CODEX_FENCE_BINARY, "/fixture/output/build/codex");
	assert.equal(env.HOME, "/fixture/isolation/home");
	for (const key of ["NODE_OPTIONS", "OPENAI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "RUSTFLAGS", "SUPABASE_URL", "QORPERA_ENFORCE_RUNTIME_BUNDLE"]) assert.equal(env[key], undefined);
	assert.equal(nativeComponentEnvironment("/fixture/isolation", "/usr/bin").QORPERA_CODEX_FENCE_BINARY, undefined);
});

test("the production socket guard rejects long CI paths and preflight removes its failed allocation", async () => {
	const previousPath = "/home/runner/work/_temp/native-component-acceptance/isolation/tmp/qorpera-codex-boundary-XXXXXX/runtime/result.sock";
	assert.equal(Buffer.byteLength(previousPath), 115);
	const directory = await realpath(await mkdtemp(join(tmpdir(), "native-component-long-socket-")));
	try {
		const longTmp = join(directory, "nested".repeat(20));
		await mkdir(longTmp, { mode: 0o700 });
		await assert.rejects(verifyNativeComponentTestSocket(longTmp), /Native result boundary requires a private Unix directory/);
		assert.deepEqual(await readdir(longTmp), []);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("short private test isolation binds the real fence socket and cleans successful or failed operations", async () => {
	for (const fail of [false, true]) {
		const evidence = {}, failure = new Error("synthetic test command failure");
		const run = withNativeComponentTestIsolation(evidence, async (root) => {
			const env = nativeComponentEnvironment(root, "/usr/bin", "/fixture/codex");
			assert.equal(await realpath(root), root);
			for (const path of [root, env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]) assert.equal((await lstat(path)).mode & 0o777, 0o700);
			assert(evidence.socketPreflight.socketBytes < 104);
			assert.equal(evidence.socketPreflight.bindConnectPassed, true);
			assert.equal(evidence.socketPreflight.socketMode, "0600");
			assert.deepEqual(await readdir(env.TMPDIR), []);
			await writeFile(join(env.HOME, "private-test-state"), "discard after test");
			if (fail) throw failure;
			return "passed";
		});
		if (fail) await assert.rejects(run, (error) => error === failure);
		else assert.equal(await run, "passed");
		assert.equal(evidence.removed, true);
		assert.equal(evidence.cleanupError, undefined);
		await assert.rejects(lstat(evidence.root), { code: "ENOENT" });
	}
});

test("component provenance accepts dev bytes and rejects source drift, substitution and symlinks", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "native-component-artifact-")));
	const contract = { rustToolchain: "1.95.0", patchSha256: digest("patch"), cargoLock: { pathPackages: 152 } };
	const binary = join(directory, "codex"), bytes = Buffer.from("synthetic component executable");
	const manifest = { schema: "qorpera.native-codex-artifact/v1", source: contract, artifact: { file: "codex", profile: "dev", target: "x86_64-unknown-linux-gnu", processing: null, compiler: "rustc 1.95.0 (fixture)", bytes: bytes.length, sha256: digest(bytes) }, cloudAcceptance: "not_performed" };
	const save = (value) => writeFile(join(directory, "artifact.json"), JSON.stringify(value));
	try {
		await writeFile(binary, bytes, { mode: 0o555 }); await save(manifest);
		assert.deepEqual(await verifyNativeComponentArtifact(directory, contract), manifest);
		await assert.rejects(verifyNativeComponentArtifact(directory, { ...contract, patchSha256: digest("changed patch") }));
		await save({ ...manifest, artifact: { ...manifest.artifact, profile: "release" } });
		await assert.rejects(verifyNativeComponentArtifact(directory, contract));
		await save(manifest); await chmod(binary, 0o755); await writeFile(binary, Buffer.alloc(bytes.length, "X")); await chmod(binary, 0o555);
		await assert.rejects(verifyNativeComponentArtifact(directory, contract), /digest mismatch/);
		await rm(binary); await writeFile(join(directory, "outside"), bytes, { mode: 0o555 }); await symlink(join(directory, "outside"), binary);
		await assert.rejects(verifyNativeComponentArtifact(directory, contract));
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("a real failed command retains its exit status, elapsed time and bounded diagnostic tail", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "native-component-command-")));
	try {
		const program = join(directory, "failure.mjs");
		await writeFile(program, 'process.stdout.write("A".repeat(8192) + "FINAL_BUILD_FAILURE"); process.exitCode = 17;\n');
		const result = await runNativeComponentCommand(process.execPath, [program], { cwd: directory, env: { PATH: process.env.PATH }, log: join(directory, "build"), timeoutMs: 5000, prefixBytes: 1024, tailBytes: 128 });
		assert.equal(result.code, 17); assert.equal(result.timedOut, false); assert(result.elapsedMs >= 0);
		assert.equal(result.prefixBytes, 1024); assert.equal(result.tailBytes, 128); assert(result.omittedMiddleBytes > 0);
		assert.match(await readFile(join(directory, "build-tail.log"), "utf8"), /FINAL_BUILD_FAILURE$/);
		assert.equal((await readFile(join(directory, "build.log"))).length, 1024);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("the real command deadline kills a stalled process group and retains its diagnostics", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "native-component-deadline-")));
	try {
		const program = join(directory, "stalled.mjs");
		const descendant = join(directory, "descendant.mjs");
		await writeFile(descendant, 'process.on("SIGTERM", () => {}); process.stdout.write("STALLED_DESCENDANT\\n"); setInterval(() => {}, 1000);\n');
		await writeFile(program, 'import { spawn } from "node:child_process"; process.on("SIGTERM", () => {}); spawn(process.execPath, [process.argv[2]], {stdio:"inherit"}); process.stdout.write("STALLED_BUILD\\n"); setInterval(() => {}, 1000);\n');
		const result = await runNativeComponentCommand(process.execPath, [program, descendant], { cwd: directory, env: { PATH: process.env.PATH }, log: join(directory, "build"), timeoutMs: 500, killGraceMs: 100 });
		assert.equal(result.timedOut, true); assert.equal(result.signal, "SIGKILL"); assert(result.elapsedMs < 3000);
		assert.match(await readFile(join(directory, "build.log"), "utf8"), /STALLED_BUILD/);
		assert.match(await readFile(join(directory, "build.log"), "utf8"), /STALLED_DESCENDANT/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});
