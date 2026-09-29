import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { describePlan, planChanged, planScript } from "./run-on-node-plan.mjs";

const names = (files) => planChanged(files).steps.map((step) => step.name);

test("documentation and the switched-off workflows run nothing", () => {
	const plan = planChanged(["README.md", "deploy/test-machine/README.md", "docs-audit/x.txt", ".github/workflows/web-client.yml"]);
	assert.deepEqual([plan.full, plan.steps.length], [false, 0]);
	assert.match(describePlan(plan, "origin/master").join("\n"), /nothing to run/);
});

test("a web-only change runs the web checks, nothing else", () => {
	const plan = planChanged(["packages/web/src/app/rail.tsx", "packages/web/test/rail.test.tsx"]);
	assert.deepEqual(plan.steps.map((step) => step.name), ["web"]);
	assert.equal(plan.build, true);
	assert.match(plan.steps[0].commands.join(" "), /typecheck --workspace packages\/web/);
});

test("SQL changes run the hosted database and its PostgreSQL scripts", () => {
	assert.deepEqual(names(["supabase/migrations/20260929010000_x.sql", "supabase/tests/700_x.test.sql"]), ["hosted-db"]);
	const plan = planChanged(["supabase/tests/700_x.test.sql"]);
	const commands = plan.steps[0].commands.join("\n");
	assert.match(commands, /npm run test:hosted-db/);
	assert.match(commands, /scripts\/test-runtime-room-history\.mjs/);
	assert.equal(plan.build, false);
});

test("runtime and runner-orchestrator sources run typecheck, their tests and packaging", () => {
	assert.deepEqual(names(["packages/runtime/src/cloud-coding-executor.ts"]), ["typecheck", "runtime", "packaging"]);
	assert.deepEqual(names(["packages/runner-orchestrator/test/coding-git.test.ts"]), ["typecheck", "runner-orchestrator"]);
	assert.deepEqual(names(["packages/runtime/src/cloud-secret-broker.ts"]), ["typecheck", "runtime", "packaging", "hosted-db"]);
});

test("shared configuration and unmapped paths run the whole npm test", () => {
	for (const file of ["package-lock.json", "packages/runtime/package.json", "packages/contracts/src/index.ts", "vitest.base.ts"]) {
		const plan = planChanged([file]);
		assert.equal(plan.full, true, file);
		assert.match(plan.reason, /shared configuration/);
	}
	const unmapped = planChanged(["new-top-level/tool.ts"]);
	assert.equal(unmapped.full, true);
	assert.match(unmapped.reason, /no step covers: new-top-level\/tool\.ts/);
	assert.match(describePlan(unmapped, "origin/master")[0], /the whole npm test/);
});

test("every step runs, a failing command fails its step, and the exit code says so", () => {
	const script = planScript([
		{ name: "first", commands: ["false", "true"] },
		{ name: "second", commands: ["true"] },
	]);
	const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.match(result.stdout, /first FAILED/);
	assert.match(result.stdout, /second passed/);
	assert.match(result.stdout, /failed: first/);
	assert.equal(spawnSync("bash", ["-c", planScript([{ name: "ok", commands: ["true"] }])]).status, 0);
});
