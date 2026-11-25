import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cacheKey } from "./folder-program-step.mjs";
import { RUST_IMAGE } from "./run-on-node-plan.mjs";
import { WEB_HOSTING_CRATES } from "./web-hosting-programs-step.mjs";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const STATUS = "runner=ci07 slot=1 queued_s=0 load=0.10 uncapped=0\nworkers=2\ninstalled=1 prepare_ms=900\n";

const STAND_IN = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
const args = process.argv.slice(2);
const script = args[0] === "run" ? args.at(-1) : "";
const kind = args[0] === "volume" ? "volume " + args[1]
	: args[0] === "ps" || args[0] === "rm" ? args[0]
	: script.includes("cargo test") ? "test"
	: script.includes("stat -c") ? "stamps"
	: "unknown";
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify({ kind, args }) + "\\n");
const wait = (name) => {
	const until = Date.now() + 10000;
	while (!fs.existsSync(path.join(dir, name))) {
		if (Date.now() > until) process.exit(99);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
	}
};
if (kind === "volume ls") console.log((config.volumes ?? []).join("\\n"));
else if (kind === "volume inspect") for (const name of args.slice(4)) console.log(name + " " + config.created[name]);
else if (kind === "volume rm") process.exit(0);
else if (kind === "ps") { console.log((config.left ?? []).join("\\n")); process.exit(config.ps ?? 0); }
else if (kind === "rm") process.exit(config.rm ?? 0);
else if (kind === "test") {
	const targetArg = args.find((a) => a.startsWith("CARGO_TARGET_DIR=")) ?? "";
	const pkg = targetArg.split("/").at(-1);
	if (config.parallel) {
		fs.writeFileSync(path.join(dir, "started-" + pkg), "");
		const other = pkg === "qorpera-web-router" ? "qorpera-app-host" : "qorpera-web-router";
		wait("started-" + other);
	}
	console.log("test result: ok (" + pkg + ")");
	process.exit((config.fail ?? {})[pkg] ?? 0);
} else process.exit(0);
`;

function tree(config) {
	const root = mkdtempSync(join(tmpdir(), "web-hosting-step-"));
	for (const crate of WEB_HOSTING_CRATES) {
		mkdirSync(join(root, crate, "src"), { recursive: true });
		writeFileSync(join(root, crate, "Cargo.toml"), `[package]\nname = "${crate.split("/").at(-1)}"\n`);
		writeFileSync(join(root, crate, "Cargo.lock"), "version = 4\n");
		writeFileSync(join(root, crate, "src/main.rs"), "fn main() {}\n");
	}
	writeFileSync(join(root, "docker"), STAND_IN);
	chmodSync(join(root, "docker"), 0o755);
	writeFileSync(join(root, "config.json"), JSON.stringify(config));
	return root;
}

function runStep(root, { status = STATUS, user = "ci07" } = {}) {
	const options = { root, docker: join(root, "docker"), status, user, now: NOW };
	const code = `import { webHostingProgramsStep } from ${JSON.stringify(new URL("./web-hosting-programs-step.mjs", import.meta.url).href)};\nprocess.exitCode = (await webHostingProgramsStep(${JSON.stringify(options)})) ? 0 : 1;`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
	const log = join(root, "calls.log");
	const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	rmSync(root, { recursive: true, force: true });
	return { passed: result.status === 0, output: result.stdout + result.stderr, calls };
}

const flags = (args, flag) => args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));

test("web-hosting-programs runs both crates in parallel with separate target subdirs in the runner volume", () => {
	const root = tree({ parallel: true });
	const routerKey = cacheKey(join(root, "crates/qorpera-web-router"));
	const hostKey = cacheKey(join(root, "crates/qorpera-app-host"));
	const ran = runStep(root);
	assert.ok(ran.passed, ran.output);
	const tests = ran.calls.filter((c) => c.kind === "test");
	assert.equal(tests.length, 2);
	const targets = tests.map((t) => flags(t.args, "-e").find((e) => e.startsWith("CARGO_TARGET_DIR="))).sort();
	assert.deepEqual(targets, ["CARGO_TARGET_DIR=/tmp/target/qorpera-app-host", "CARGO_TARGET_DIR=/tmp/target/qorpera-web-router"]);
	for (const t of tests) {
		assert.ok(flags(t.args, "-v").includes("qorpera-web-hosting-target-ci07:/tmp/target"));
		assert.ok(flags(t.args, "-v").includes("qorpera-cargo-registry:/usr/local/cargo/registry"));
		assert.deepEqual(flags(t.args, "--label"), ["qorpera.web-hosting-target=qorpera-web-hosting-target-ci07"]);
		assert.equal(t.args.at(-4), RUST_IMAGE);
	}
	assert.ok(tests.some((t) => flags(t.args, "-e").includes(`KEY=${routerKey}`)));
	assert.ok(tests.some((t) => flags(t.args, "-e").includes(`KEY=${hostKey}`)));
	assert.match(ran.output, /test result: ok \(qorpera-web-router\)/);
	assert.match(ran.output, /test result: ok \(qorpera-app-host\)/);
	assert.equal(ran.calls.filter((c) => c.kind === "volume rm").length, 0);
});

test("web-hosting-programs removes ephemeral volume outside runner user and fails when either crate fails", () => {
	const failed = runStep(tree({ fail: { "qorpera-app-host": 101 } }), { user: "tester" });
	assert.equal(failed.passed, false);
	assert.match(failed.output, /crates\/qorpera-app-host FAILED \(101\)/);
	const removed = failed.calls.filter((c) => c.kind === "volume rm");
	assert.equal(removed.length, 1);
	assert.match(removed[0].args[2], new RegExp(`^qorpera-web-hosting-target-run-${NOW}-[0-9]+$`));
});
