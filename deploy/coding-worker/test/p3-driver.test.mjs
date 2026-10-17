// What node --check cannot see in the P3 driver: that its imports link, and that no top-level binding is declared below
// the main flow's start (the flow's callbacks would find it uninitialized: a run's ReferenceError at its first core call,
// 38 minutes in). The run-on-node plan's deploy-node step runs it, and prove-coding-session-vm.sh before it builds
// anything.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("./p3-driver.mjs", import.meta.url));

test("the driver's imports link and it stops at its usage line", () => {
	const run = spawnSync(process.execPath, [driver], { encoding: "utf8" });
	assert.match(run.stderr, /usage: p3-driver\.mjs/, run.stderr);
});

test("no top-level binding is declared below the main flow's start", () => {
	const lines = readFileSync(driver, "utf8").split("\n");
	const start = lines.findIndex((line) => line.startsWith("const db = await "));
	assert.ok(start > 0, "the driver's main flow starts at `const db = await …`");
	const late = lines
		.map((line, index) => `${index + 1}: ${line}`)
		.slice(start + 1)
		.filter((line) => /^\d+: (const|let|var|class) /.test(line))
		.filter((line) => !/^\d+: let (executor|stopping|postgrest);$/.test(line));
	assert.deepEqual(late, []);
});
