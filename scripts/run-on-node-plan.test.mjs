import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describePlan, planChanged, planScript, STEPS } from "./run-on-node-plan.mjs";

/** Step names as a sorted set: the tests check which steps run; STEPS fixes their order. */
const names = (files) => planChanged(files).steps.map((step) => step.name).sort();
const set = (list) => [...list].sort();
const ALWAYS = ["lint", "typecheck", "checks"];
const BASELINE = [...ALWAYS, "cloud-client", "runtime", "scripts"];

test("documentation and the switched-off workflows run nothing", () => {
	const plan = planChanged(["README.md", "deploy/test-machine/README.md", "docs-audit/x.txt", ".github/workflows/web-client.yml"]);
	assert.deepEqual([plan.full, plan.steps.length], [false, 0]);
	assert.match(describePlan(plan, "origin/master").join("\n"), /nothing to run/);
});

test("a web-only change runs the always-on checks and the web client, including its release build", () => {
	const plan = planChanged(["packages/web/src/app/rail.tsx", "packages/web/test/rail.test.tsx"]);
	assert.deepEqual(plan.steps.map((step) => step.name), [...ALWAYS, "web"]);
	assert.equal(plan.build, true);
	const web = plan.steps.find((step) => step.name === "web").commands.join("\n");
	assert.match(web, /typecheck --workspace packages\/web/);
	assert.match(web, /git init -q && git add -A && .*commit -qm snapshot/);
	assert.match(web, /QORPERA_WEB_CONFIG_JSON='\{"projectUrl"[^']+' npm run build:release --workspace packages\/web; built=\$\?; rm -rf \.git; exit \$built/);
});

test("anything that is not web-only also runs runtime, cloud-client and every script test (the old release train)", () => {
	// The web client's cloud code and member-web's viewer are read by runtime tests.
	assert.deepEqual(names(["packages/web/src/cloud/email-drafts.ts"]), set([...BASELINE, "web", "hosted-db"]));
	assert.deepEqual(names(["packages/member-web/ui/viewer.ts"]), set([...BASELINE, "web", "member-web"]));
	// A migration reaches runtime tests that read the migrations directory, and the vocabulary script test.
	assert.deepEqual(names(["supabase/migrations/20260929010000_x.sql"]), set([...BASELINE, "hosted-db", "folder-core-load"]));
	// Installer pins: runner-orchestrator sources rebuild packages whose sha256 the deploy scripts pin.
	assert.deepEqual(names(["packages/runner-orchestrator/src/lxd-provider.ts"]), set([
		...BASELINE,
		"runner-orchestrator",
		"deploy-node",
	]));
	assert.deepEqual(names(["packages/runtime/test/cloud-coding-executor.test.ts"]), set(BASELINE));
	assert.deepEqual(names(["packages/cloud-client/src/node/cloud-object-store.ts"]), set([...BASELINE, "web", "runner-orchestrator"]));
	const scripts = STEPS.find((step) => step.name === "scripts").commands.join(" ");
	assert.match(scripts, /node --test scripts\/\*\.test\.mjs/);
});

test("deploy, function and SQL-input paths reach the tests that read them", () => {
	assert.deepEqual(names(["deploy/lxd-company-computer-guest/office-self-update-mask.ts"]), set([
		...BASELINE,
		"runner-orchestrator",
		"deploy-node",
	]));
	assert.deepEqual(names(["deploy/node-agent/qorpera-node-launch.py"]), set([...BASELINE, "runner-orchestrator", "deploy-node"]));
	// Files runner-orchestrator tests read outside its package (review round 2).
	for (const file of [
		"deploy/coding-worker/qorpera-coding-executor.service",
		"deploy/cloud-secret-broker/supabase-prod-ca-2021.crt",
		"packages/runtime/test/fixtures/company-computer-guest.ts",
		"packages/runtime/src/cloud-identity-recovery-filesystems.ts",
		"packages/cloud-client/src/node/native-account-refresh.ts",
	])
		assert.ok(names([file]).includes("runner-orchestrator"), file);
	assert.deepEqual(names(["deploy/first-node/install.sh"]), set([...BASELINE, "runner-orchestrator", "deploy-node", "deploy-shell"]));
	assert.deepEqual(names(["supabase/functions/company-file-verifier/object-loader.ts"]), set([...BASELINE, "web", "functions"]));
	const functions = STEPS.find((step) => step.name === "functions").commands.join(" ");
	assert.match(functions, /company-file-verifier\.test\.ts/);
	assert.match(functions, /runner-orchestrator\/runner-orchestrator\.test\.ts/);
	assert.match(functions, /event-intake\/event-intake\.test\.ts/);
	assert.match(functions, /mail-intake\/mail-intake\.test\.ts/);
	assert.match(functions, /mail-outbox\/mail-outbox\.test\.ts/);
	assert.match(functions, /runner-control\/runner-control\.test\.ts/);
	assert.ok(names(["scripts/test-runtime-node-capacity-cases.mjs"]).includes("hosted-db"));
	assert.ok(names(["packages/runner-orchestrator/src/lxd-office-start-control.ts"]).includes("hosted-db"));
	// The office delete-disposition script's runtime bundle: its entry points and the files they import.
	for (const file of [
		"packages/runtime/src/cloud-company-computer-startup.ts",
		"packages/runtime/src/cloud-company-computer-screen-lifecycle.ts",
		"packages/runtime/src/cloud-company-computer-screen-outbox.ts",
		"packages/runtime/src/cloud-company-computer-registry-http.ts",
		"packages/runtime/src/cloud-native-tool-authority.ts",
		"packages/runtime/src/cloud-control-errors.ts",
		"packages/runtime/src/cloud-runtime-observability.ts",
		"packages/runtime/src/cloud-runtime-policy.ts",
	])
		assert.ok(names([file]).includes("hosted-db"), file);
	// The wake bus and company context parsers fed only the deleted production review and wake bus scripts.
	for (const file of ["packages/runtime/src/cloud-wake-bus.ts", "packages/runtime/src/cloud-native-company-context.ts"])
		assert.ok(!names([file]).includes("hosted-db"), file);
	// No hosted-db script reads the coding turn sample since C1c-3i removed the snapshot-v1 coding backfill script.
	assert.ok(!names(["packages/runtime/test/fixtures/coding-turn-context-backfilled.json"]).includes("hosted-db"));
	// The folder service's shapes script and the parsers it checks against SQL.
	for (const file of [
		"scripts/test-folder-service-core-shapes.mjs",
		"packages/object-gateway/src/folder-service/core.ts",
		"packages/object-gateway/src/folder-service/view-tree.ts",
	])
		assert.ok(names([file]).includes("hosted-db"), file);
	// The folder core's acceptance script (F3-3c): the folder service's write path and the gateway parts it puts through.
	for (const file of [
		"scripts/test-folder-core-acceptance.mjs",
		"packages/object-gateway/src/folder-service/https-request.ts",
		"packages/object-gateway/src/folder-service/service.ts",
		"packages/object-gateway/src/folder-service/staging.ts",
		"packages/object-gateway/src/folder-service/mounts.ts",
		"packages/object-gateway/src/folder-service/machines.ts",
		"packages/object-gateway/src/folder-service/plan.ts",
		"packages/object-gateway/src/folder-service/pending.ts",
		"packages/object-gateway/src/folder-service/protocol.ts",
		"packages/object-gateway/src/folder-service/objects.ts",
		"packages/object-gateway/src/folder-service/search.ts",
		"packages/object-gateway/src/service.ts",
		"packages/object-gateway/src/supabase-authority.ts",
		"packages/object-gateway/src/supabase-headers.ts",
		"packages/object-gateway/src/folder-service-objects.ts",
		"packages/object-gateway/src/folder-objects.ts",
		"packages/object-gateway/src/member-folder-commits.ts",
	])
		assert.ok(names([file]).includes("hosted-db"), file);
	for (const file of ["packages/object-gateway/src/folder-service/server.ts", "packages/object-gateway/src/folder-service/cli.ts"])
		assert.ok(!names([file]).includes("hosted-db"), file);
	// The rolling update rehearsal and the packets it runs.
	for (const file of ["scripts/test-runtime-roll.mjs", "scripts/runtime-roll.mjs"]) assert.ok(names([file]).includes("hosted-db"), file);
	assert.ok(!names(["packages/runtime/test/fixtures/company-computer-guest.ts"]).includes("hosted-db"));
	assert.equal(STEPS.find((step) => step.name === "hosted-db").build, true);
});

test("a migration, the folder load test or its fixture puts one folder-v2 company under load", () => {
	for (const file of [
		"supabase/migrations/20260928339380_company_fence_shared_readers.sql",
		"scripts/load-folder-core.mjs",
		"scripts/load-folder-core.sql",
		"supabase/tests/648_folder_core_run_fence_concurrency.test.sql",
	])
		assert.ok(names([file]).includes("folder-core-load"), file);
	assert.ok(!names(["supabase/tests/850_folder_core_vault_lock_order.test.sql"]).includes("folder-core-load"));
	assert.ok(!names(["packages/runtime/src/cloud-company-path-control.ts"]).includes("folder-core-load"));
	const load = STEPS.find((step) => step.name === "folder-core-load").commands.join(" ");
	assert.equal(load, "node scripts/load-folder-core.mjs --runs 16 --seconds 30 --big-paths 5000 --check");
});

test("the folder program runs its own step in the pinned Rust image", () => {
	const plan = planChanged(["crates/qorpera-folder/src/mount.rs", "crates/qorpera-folder/Cargo.lock"]);
	assert.equal(plan.full, false);
	assert.ok(names(["crates/qorpera-folder/src/mount.rs"]).includes("folder-program"));
	assert.ok(!names(["packages/object-gateway/src/cli.ts"]).includes("folder-program"));
	const command = STEPS.find((step) => step.name === "folder-program").commands.join(" ");
	assert.match(command, /rust:1\.95\.0-slim-bookworm@sha256:[0-9a-f]{64} sh -c 'cargo test --locked && cargo build/);
	assert.match(command, /node:24\.21\.0-bookworm-slim@sha256:[0-9a-f]{64} sh -c 'node \.\.\/\.\.\/scripts\/folder-program-artifact\.mjs --check \/out\/qorpera-folder && node .* test\/folder-mount-e2e\.test\.ts'/);
	// A changed build record is checked against a build of today's source.
	assert.ok(names(["deploy/folder-service/folder-program-linux-x64.json"]).includes("folder-program"));
	assert.match(command, /--device \/dev\/fuse/);
	assert.ok(names(["packages/object-gateway/src/folder-service/service.ts"]).includes("folder-program"));
});

test("shared configuration and unknown paths run every step", () => {
	for (const file of ["package-lock.json", "packages/runtime/package.json", "packages/contracts/src/index.ts", "tsconfig.json"]) {
		const plan = planChanged([file]);
		assert.equal(plan.full, true, file);
		assert.deepEqual(plan.steps.map((step) => step.name), STEPS.map((step) => step.name), file);
		assert.match(plan.reason, /shared configuration/);
	}
	assert.deepEqual(STEPS.find((step) => step.name === "contracts").commands, ["npm test --workspace packages/contracts"]);
	const unknown = planChanged(["new-top-level/tool.ts"]);
	assert.equal(unknown.full, true);
	assert.match(unknown.reason, /no rule knows: new-top-level\/tool\.ts/);
	assert.match(describePlan(unknown, "origin/master")[0], /every step/);
});

test("every step runs, a failing command fails its step, and the exit code says so", () => {
	const script = planScript([
		{ name: "first", commands: ["false", "true"] },
		{ name: "second", commands: ["true"] },
	]);
	// The script writes the failed step names into .run-on-node-status in its working directory.
	const cwd = mkdtempSync(join(tmpdir(), "plan-script-"));
	try {
		const result = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8" });
		assert.equal(result.status, 1);
		assert.match(result.stdout, /first FAILED/);
		assert.match(result.stdout, /second passed/);
		assert.match(result.stdout, /failed: first/);
		assert.equal(readFileSync(join(cwd, ".run-on-node-status"), "utf8"), "failed_steps=first\n");
		assert.equal(spawnSync("bash", ["-c", planScript([{ name: "ok", commands: ["true"] }])], { cwd }).status, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("deploy-shell fails when any script, not only the last, has a syntax error", () => {
	const root = mkdtempSync(join(tmpdir(), "deploy-shell-"));
	try {
		mkdirSync(join(root, "deploy/a"), { recursive: true });
		writeFileSync(join(root, "deploy/a/broken.sh"), "if then fi\n");
		writeFileSync(join(root, "deploy/z-fine.sh"), "true\n");
		const step = STEPS.find((candidate) => candidate.name === "deploy-shell");
		const result = spawnSync("bash", ["-c", planScript([step])], { cwd: root, encoding: "utf8" });
		assert.equal(result.status, 1, result.stdout);
		assert.match(result.stdout, /deploy-shell FAILED/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
