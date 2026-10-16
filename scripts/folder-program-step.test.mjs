import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CARGO_BUILD, CRATE, folderProgramSourceSha256, RECORD } from "./folder-program-artifact.mjs";
import { cacheKey, cacheRunner } from "./folder-program-step.mjs";
import { NODE_IMAGE, RUST_IMAGE } from "./run-on-node-plan.mjs";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const STATUS = "runner=ci07 slot=1 queued_s=0 load=0.10 uncapped=0\nworkers=2\ninstalled=1 prepare_ms=900\n";

/** A stand-in for docker: it logs each call, answers from config.json, and with `beside` makes the tests and the run
 * against the service wait for each other, so the step passes only if they run at the same time. */
const STAND_IN = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
const args = process.argv.slice(2);
const script = args[0] === "run" ? args.at(-1) : "";
const kind = args[0] === "volume" ? "volume " + args[1]
	: script.includes(".qorpera-key") ? "prepare"
	: script.includes("cargo test") ? "test"
	: script.includes("rm -rf /tmp/target/release") ? "clean build"
	: script.includes("cargo build") ? "build"
	: script.includes("--check") ? "check"
	: script.includes("vitest") ? "e2e"
	: script.includes("stat -c") ? "stamps"
	: "unknown";
const log = path.join(dir, "calls.log");
const round = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\\n").filter((line) => line && JSON.parse(line).kind === kind).length : 0;
fs.appendFileSync(log, JSON.stringify({ kind, args }) + "\\n");
const wait = (name) => {
	const until = Date.now() + 10000;
	while (!fs.existsSync(path.join(dir, name))) {
		if (Date.now() > until) process.exit(99);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
	}
};
const exit = (code) => process.exit(Array.isArray(code) ? (code[round] ?? 0) : (code ?? 0));
if (kind === "volume ls") console.log(config.volumes.join("\\n"));
else if (kind === "volume inspect") for (const name of args.slice(4)) console.log(name + " " + config.created[name]);
else if (kind === "volume rm") exit(args.some((name) => (config.inUse ?? []).includes(name)) ? 1 : 0);
else if (kind === "volume create") exit(0);
else if (kind === "prepare") { console.log(config.cache); exit(config.prepare); }
else if (kind === "test") {
	if (config.beside) { fs.writeFileSync(path.join(dir, "test-started"), ""); wait("e2e-started"); }
	console.log("test result: ok (stand-in)");
	exit(config.test);
} else if (kind === "build" || kind === "clean build") exit(config.build);
else if (kind === "check") exit(config.check);
else if (kind === "e2e") {
	if (config.beside) { wait("test-started"); fs.writeFileSync(path.join(dir, "e2e-started"), ""); }
	exit(config.e2e);
} else if (kind === "stamps")
	for (const mount of args.filter((arg) => arg.includes(":/v/"))) {
		const name = mount.split(":")[0];
		console.log(name + " " + (config.stamps[name] ?? 0));
	}
else process.exit(98);
`;

/** A tree with a crate, its build record (naming its source when `recorded`) and the stand-in docker. */
function tree(config, { recorded = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), "folder-program-step-"));
	mkdirSync(join(root, CRATE, "src"), { recursive: true });
	writeFileSync(join(root, CRATE, "Cargo.toml"), '[package]\nname = "qorpera-folder"\n');
	writeFileSync(join(root, CRATE, "Cargo.lock"), "version = 4\n");
	writeFileSync(join(root, CRATE, "src/main.rs"), "fn main() {}\n");
	mkdirSync(join(root, "deploy/folder-service"), { recursive: true });
	const sourceSha256 = recorded ? folderProgramSourceSha256(root) : "0".repeat(64);
	const record = { schema: "qorpera.folder-program-artifact/v1", image: RUST_IMAGE, target: "x86_64-unknown-linux-gnu", profile: "release", sourceSha256, bytes: 1, sha256: "1".repeat(64) };
	writeFileSync(join(root, RECORD), JSON.stringify(record));
	writeFileSync(join(root, "docker"), STAND_IN);
	chmodSync(join(root, "docker"), 0o755);
	writeFileSync(join(root, "config.json"), JSON.stringify({ volumes: [], cache: "kept", ...config }));
	return root;
}

/** Runs the step in its own process against the stand-in: its result, output and the docker calls in order. */
function step(root, { status = STATUS, user = "ci07" } = {}) {
	const options = { root, docker: join(root, "docker"), status, user, now: NOW };
	const code = `import { folderProgramStep } from ${JSON.stringify(new URL("./folder-program-step.mjs", import.meta.url).href)};\nprocess.exitCode = (await folderProgramStep(${JSON.stringify(options)})) ? 0 : 1;`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
	const log = join(root, "calls.log");
	const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	rmSync(root, { recursive: true, force: true });
	return { passed: result.status === 0, output: result.stdout + result.stderr, calls, kinds: calls.map((call) => call.kind) };
}

const call = (calls, kind) => calls.find((entry) => entry.kind === kind)?.args ?? [];
/** The value after each `flag` in docker's arguments. */
const flags = (args, flag) => args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));

test("the cache is the runner user's own only when run-on-node's status names the user this runs as", () => {
	assert.equal(cacheRunner(STATUS, "ci07"), "ci07");
	assert.equal(cacheRunner(STATUS, "ci08"), null);
	assert.equal(cacheRunner(STATUS, "tester"), null);
	assert.equal(cacheRunner("", "ci07"), null);
	assert.equal(cacheRunner("runner= slot=1\n", ""), null);
	assert.equal(cacheRunner("workers=2\nrunner=ci07 slot=1\n", "ci07"), null);
});

test("the cache key follows the image, the manifest and the lock file, not the program's own source", () => {
	const root = tree({});
	const crate = join(root, CRATE);
	const key = cacheKey(crate);
	assert.match(key, /^[0-9a-f]{64}$/);
	writeFileSync(join(crate, "src/main.rs"), "fn main() { println!(); }\n");
	assert.equal(cacheKey(crate), key);
	assert.notEqual(cacheKey(crate, `${RUST_IMAGE}x`), key);
	for (const [name, text] of [["Cargo.lock", "version = 3\n"], ["Cargo.toml", '[package]\nname = "other"\n'], ["build.rs", "fn main() {}\n"]]) {
		const path = join(crate, name);
		const before = existsSync(path) ? readFileSync(path) : null;
		writeFileSync(path, text);
		assert.notEqual(cacheKey(crate), key, name);
		if (before === null) rmSync(path);
		else writeFileSync(path, before);
		assert.equal(cacheKey(crate), key, name);
	}
	rmSync(root, { recursive: true, force: true });
});

test("the tests run beside the release build, its check and the program against the service, in the runner's volume", () => {
	const root = tree({ beside: true });
	const crate = join(root, CRATE);
	const key = cacheKey(crate);
	const ran = step(root);
	assert.ok(ran.passed, ran.output);
	// The tests start beside the build (either may log first); the build, its check and the e2e follow each other.
	assert.deepEqual(ran.kinds.filter((kind) => !["volume ls", "test"].includes(kind)), ["volume create", "prepare", "build", "check", "e2e", "volume rm"]);
	assert.equal(ran.kinds.filter((kind) => kind === "test").length, 1);
	assert.ok(ran.kinds.indexOf("test") > ran.kinds.indexOf("prepare") && ran.kinds.indexOf("test") < ran.kinds.indexOf("volume rm"));
	const [out] = call(ran.calls, "volume create").slice(2);
	assert.match(out, new RegExp(`^qorpera-folder-out-${NOW}-[0-9]+$`));
	// Every Rust container has the runner's target volume, the crates' cache and the source read-only.
	for (const kind of ["prepare", "test", "build"]) {
		const args = call(ran.calls, kind);
		assert.ok(flags(args, "-v").includes("qorpera-folder-target-ci07:/tmp/target"), kind);
		assert.ok(flags(args, "-v").includes("qorpera-cargo-registry:/usr/local/cargo/registry"), kind);
		assert.ok(flags(args, "-v").includes(`${crate}:/src:ro`), kind);
		assert.ok(flags(args, "-e").includes("CARGO_TARGET_DIR=/tmp/target"), kind);
		assert.equal(args.at(-4), RUST_IMAGE, kind);
	}
	assert.match(RUST_IMAGE, /^rust:1\.95\.0-slim-bookworm@sha256:[0-9a-f]{64}$/);
	assert.ok(flags(call(ran.calls, "prepare"), "-e").includes(`KEY=${key}`));
	const tests = call(ran.calls, "test");
	assert.ok(flags(tests, "--device").includes("/dev/fuse") && flags(tests, "--cap-add").includes("SYS_ADMIN"));
	assert.ok(flags(tests, "-e").includes("QORPERA_FOLDER_FUSE_TESTS=1"));
	assert.equal(tests.at(-1), "cargo clean --locked -p qorpera-folder && cargo test --locked");
	const build = call(ran.calls, "build");
	assert.ok(flags(build, "-v").includes(`${out}:/out`));
	assert.equal(build.at(-1), `cargo clean --locked -p qorpera-folder --release && ${CARGO_BUILD} && cp /tmp/target/release/qorpera-folder /out/`);
	// The check and the run against the service read the program from the run's own volume, in Node.
	for (const kind of ["check", "e2e"]) {
		const args = call(ran.calls, kind);
		assert.ok(flags(args, "-v").includes(`${out}:/out:ro`) && flags(args, "-v").includes(`${root}:/repo`), kind);
		assert.ok(flags(args, "-e").includes("QORPERA_FOLDER_MOUNT_BIN=/out/qorpera-folder"), kind);
		assert.equal(args.at(-4), NODE_IMAGE, kind);
	}
	assert.match(NODE_IMAGE, /^node:24\.21\.0-bookworm-slim@sha256:[0-9a-f]{64}$/);
	assert.equal(call(ran.calls, "check").at(-1), "node ../../scripts/folder-program-artifact.mjs --check /out/qorpera-folder");
	const e2e = call(ran.calls, "e2e");
	assert.ok(flags(e2e, "--device").includes("/dev/fuse"));
	assert.equal(e2e.at(-1), "node ../../node_modules/vitest/dist/cli.js --run test/folder-mount-e2e.test.ts");
	// Only the run's own volume is removed; the runner's stays for its next run.
	assert.deepEqual(call(ran.calls, "volume rm").slice(2), [out]);
	assert.match(ran.output, /compiled crates in qorpera-folder-target-ci07 kept/);
	assert.match(ran.output, /== folder-program: the unit and FUSE tests \(ran beside\)\ntest result: ok \(stand-in\)/);
});

test("outside a runner user the target volume is the run's own, emptied first and removed at the end", () => {
	const ran = step(tree({ cache: "emptied" }), { user: "tester" });
	assert.ok(ran.passed, ran.output);
	const target = flags(call(ran.calls, "prepare"), "-v").find((mount) => mount.endsWith(":/tmp/target")).split(":")[0];
	assert.match(target, new RegExp(`^qorpera-folder-target-run-${NOW}-[0-9]+$`));
	assert.deepEqual(call(ran.calls, "volume rm").slice(2), [...call(ran.calls, "volume create").slice(2), target]);
	assert.match(ran.output, /compiled crates in qorpera-folder-target-run-\S+ emptied for a clean build/);
});

test("the step fails when any part fails, and still shows the tests", () => {
	for (const [config, ran, missing] of [
		[{ test: 101 }, ["test", "build", "check", "e2e"], []],
		[{ e2e: 1 }, ["test", "build", "check", "e2e"], []],
		[{ build: 101 }, ["test", "build"], ["check", "e2e"]],
		[{ prepare: 1 }, ["prepare"], ["test", "build"]],
	]) {
		const result = step(tree(config));
		assert.equal(result.passed, false, JSON.stringify(config));
		for (const kind of ran) assert.ok(result.kinds.includes(kind), `${JSON.stringify(config)} ran ${kind}`);
		for (const kind of missing) assert.ok(!result.kinds.includes(kind), `${JSON.stringify(config)} skipped ${kind}`);
		if (ran.includes("test")) assert.match(result.output, /\(ran beside\)\ntest result: ok/);
	}
});

test("a build from kept crates that fails the check is built again from clean, and that build decides", () => {
	const again = step(tree({ check: [1, 0] }));
	assert.ok(again.passed, again.output);
	assert.deepEqual(again.kinds.filter((kind) => ["build", "clean build", "check", "e2e"].includes(kind)), ["build", "check", "clean build", "check", "e2e"]);
	assert.equal(call(again.calls, "clean build").at(-1), `rm -rf /tmp/target/release && ${CARGO_BUILD} && cp /tmp/target/release/qorpera-folder /out/`);
	assert.match(again.output, /not the recorded one; building again from clean/);
	const still = step(tree({ check: [1, 1] }));
	assert.equal(still.passed, false);
	assert.deepEqual(still.kinds.filter((kind) => ["build", "clean build", "check", "e2e"].includes(kind)), ["build", "check", "clean build", "check"]);
	// A clean build is not tried again, nor any build when the record names other source.
	for (const [config, recorded] of [[{ cache: "emptied", check: [1, 0] }, true], [{ check: [1, 0] }, false]]) {
		const once = step(tree(config, { recorded }));
		assert.equal(once.passed, false, JSON.stringify(config));
		assert.deepEqual(once.kinds.filter((kind) => ["build", "clean build", "check", "e2e"].includes(kind)), ["build", "check"]);
	}
});

test("other runners' volumes unused for two days and single runs' volumes from a killed run go; nothing else does", () => {
	const seconds = (ms) => String(Math.floor(ms / 1000));
	const ran = step(
		tree({
			volumes: [
				"qorpera-folder-target-ci07",
				"qorpera-folder-target-ci03",
				"qorpera-folder-target-ci04",
				"qorpera-folder-target-ci05",
				"qorpera-folder-out-1760000000000-12",
				"qorpera-folder-1760000000000000000",
				"qorpera-folder-target-run-1760000000000-34",
				"qorpera-folder-target-run-1760000000000-56",
				"qorpera-folder-target-measure-9",
				"qorpera-cargo-registry",
			],
			stamps: { "qorpera-folder-target-ci03": seconds(NOW - 49 * HOUR), "qorpera-folder-target-ci04": seconds(NOW - 47 * HOUR) },
			created: {
				"qorpera-folder-out-1760000000000-12": new Date(NOW - 25 * HOUR).toISOString(),
				"qorpera-folder-1760000000000000000": "2026-10-13T09:00:00+00:00",
				"qorpera-folder-target-run-1760000000000-34": new Date(NOW - HOUR).toISOString(),
				"qorpera-folder-target-run-1760000000000-56": new Date(NOW - 30 * HOUR).toISOString(),
			},
			inUse: ["qorpera-folder-target-run-1760000000000-56"],
		}),
	);
	assert.ok(ran.passed, ran.output);
	// The run's own volume is never read or removed; ci05 has no stamp, so it never finished preparing.
	assert.deepEqual(flags(call(ran.calls, "stamps"), "-v"), ["ci03", "ci04", "ci05"].map((runner) => `qorpera-folder-target-${runner}:/v/qorpera-folder-target-${runner}:ro`));
	const [out] = call(ran.calls, "volume create").slice(2);
	const removed = ran.calls.filter((entry) => entry.kind === "volume rm").map((entry) => entry.args.slice(2).join(" "));
	assert.deepEqual(removed.filter((names) => names !== out).sort(), [
		"qorpera-folder-1760000000000000000",
		"qorpera-folder-out-1760000000000-12",
		"qorpera-folder-target-ci03",
		"qorpera-folder-target-ci05",
		"qorpera-folder-target-run-1760000000000-56",
	]);
	assert.match(ran.output, /removed the unused volume qorpera-folder-target-ci03/);
	assert.doesNotMatch(ran.output, /removed the unused volume qorpera-folder-target-run-1760000000000-56/);
});
