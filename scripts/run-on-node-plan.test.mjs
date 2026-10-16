import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	ALL_STARTED,
	beside,
	describePlan,
	planChanged,
	planScript,
	RUNNER_ORCHESTRATOR_WAITING,
	RUNTIME_WAITING,
	STEPS,
	STOP,
	splitPlan,
} from "./run-on-node-plan.mjs";
import { POSTGRES_IMAGE } from "./test-hosted-db.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Step names as a sorted set: the tests check which steps run; STEPS fixes their order. */
const names = (files) => planChanged(files).steps.map((step) => step.name).sort();
const set = (list) => [...list].sort();
const ALWAYS = ["lint", "typecheck", "checks"];
const BASELINE = [...ALWAYS, "cloud-client", "runtime", "scripts"];
/** These tests run inside run-on-node's own side-by-side runs, which set QORPERA_RUN_CORES_FILE: a script under test
 * gets only the file its test gives it. */
const env = (coresFile) => {
	const { QORPERA_RUN_CORES_FILE: _, ...rest } = process.env;
	return coresFile ? { ...rest, QORPERA_RUN_CORES_FILE: coresFile } : rest;
};
/** The most cores in use at once, from the start and end events the steps logged. */
const mostCores = (events, cores) => {
	let used = 0;
	let most = 0;
	for (const event of events) {
		const [kind, name] = event.split(" ");
		used += kind === "start" ? cores[name] : -cores[name];
		most = Math.max(most, used);
	}
	assert.equal(used, 0);
	return most;
};

test("documentation and the switched-off workflows run nothing", () => {
	const plan = planChanged(["README.md", "deploy/test-machine/README.md", "docs-audit/x.txt", ".github/workflows/web-client.yml"]);
	assert.deepEqual([plan.full, plan.steps.length], [false, 0]);
	assert.match(describePlan(plan, "origin/master").join("\n"), /nothing to run/);
});

test("a web-only change runs the always-on checks and the web client, including its release build", () => {
	const plan = planChanged(["packages/web/src/app/rail.tsx", "packages/web/test/rail.test.tsx"]);
	assert.deepEqual(plan.steps.map((step) => step.name), [...ALWAYS, "web"]);
	assert.equal(plan.build, true);
	const step = plan.steps.find((candidate) => candidate.name === "web");
	const web = [...step.commands, ...step.alone].join("\n");
	assert.match(web, /typecheck --workspace packages\/web/);
	// The snapshot and the release build need the tree to themselves.
	assert.match(step.alone.join("\n"), /git init -q[^]*build:release/);
	assert.doesNotMatch(step.commands.join("\n"), /git init|build:release/);
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

test("in parts, every step runs in exactly one part, the heaviest work first to the lightest part, in plan order, the most work first", () => {
	const groupNames = (groups) => groups.map((group) => group.steps.map((step) => step.name));
	// The full plan in two parts: runner-orchestrator (588 s × 3 cores) outweighs every other step together, so it runs
	// alone, without the build; the other part has all the rest, the build and the alone checks.
	const full = planChanged(["package-lock.json"]).steps;
	const two = splitPlan(full, 2);
	assert.deepEqual(groupNames(two), [
		["runner-orchestrator"],
		full.map((step) => step.name).filter((name) => name !== "runner-orchestrator"),
	]);
	assert.deepEqual(two.map((group) => group.build), [false, true]);
	assert.deepEqual(groupNames(splitPlan(full, 1)), [full.map((step) => step.name)]);
	assert.equal(splitPlan(full, 1)[0].build, true);
	for (const parts of [2, 3, 5]) {
		const groups = splitPlan(full, parts);
		assert.equal(groups.length, parts);
		assert.ok(groups.every((group) => group.steps.length > 0), String(parts));
		assert.deepEqual(groups.flatMap((group) => group.steps.map((step) => step.name)).sort(), full.map((step) => step.name).sort());
		for (const group of groups)
			assert.deepEqual(group.steps, full.filter((step) => group.steps.includes(step)), "plan order");
	}
	// Work is seconds × cores; at equal work a step goes to the part with the fewest steps, so steps without a measured
	// time spread over the parts. Fewer steps than parts make one part per step.
	const steps = [{ name: "a", seconds: 50, cores: 2 }, { name: "b", seconds: 100, build: true }, { name: "c" }, { name: "d" }, { name: "e" }];
	assert.deepEqual(groupNames(splitPlan(steps, 2)), [
		["a", "c", "e"],
		["b", "d"],
	]);
	assert.deepEqual(splitPlan(steps, 2).map((group) => group.build), [false, true]);
	assert.deepEqual(groupNames(splitPlan(steps.slice(2), 2)), [["c", "e"], ["d"]]);
	assert.deepEqual(groupNames(splitPlan(steps.slice(0, 2), 5)), [["a"], ["b"]]);
	// The part with the most work comes first, though its steps went to it later.
	assert.deepEqual(groupNames(splitPlan([{ name: "a", seconds: 100 }, { name: "b", seconds: 60 }, { name: "c", seconds: 60 }], 2)), [["b", "c"], ["a"]]);
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

test("one step at a time, a step runs its alone commands after its others", () => {
	const script = planScript([{ name: "web", commands: ["echo one"], alone: ["echo two"] }]);
	const result = spawnSync("bash", ["-c", script], { cwd: tmpdir(), encoding: "utf8" });
	assert.equal(result.status, 0);
	assert.match(result.stdout, /^== changed: web\none\ntwo\n== changed: web passed in \d+ s\n== changed: all steps passed\n$/);
	// Every planned step has the fields planScript reads.
	for (const step of planChanged(["package-lock.json"]).steps) {
		assert.ok(Array.isArray(step.commands) && Array.isArray(step.alone), step.name);
		assert.ok(step.commands.length + step.alone.length > 0, step.name);
		assert.ok(step.cores > 0 && step.seconds >= 0, step.name);
	}
	// The tree-wide checks run alone, so nothing else writes while they read every file.
	for (const name of ["lint", "typecheck", "checks"])
		assert.deepEqual(STEPS.find((step) => step.name === name).commands, [], name);
});

test("side by side: alone parts first and alone, then the rest longest first within the cores, each step's output whole", () => {
	// Each rest part logs its start and end; the alone parts fail if any rest part has started.
	const rest = (name, more) => `echo "start ${name}" >>events; ${more}; s=$?; echo "end ${name}" >>events; exit $s`;
	const steps = [
		{ name: "lint", commands: [], alone: ["echo lint-ran", "[ ! -e events ]"] },
		{ name: "web", commands: [rest("web", "echo web-rest")], alone: ["echo web-alone", "[ ! -e events ]"], cores: 2 },
		{ name: "short", commands: [rest("short", "echo short-done")], seconds: 1 },
		{ name: "long", commands: [rest("long", "sleep 2; echo long-done")], seconds: 100 },
		{ name: "bad", commands: [rest("bad", "sleep 1; echo bad-out; false")], seconds: 50 },
		{ name: "half", commands: [rest("half", "true")], alone: ["false"] },
	];
	const script = planScript(steps, { cores: 2 });
	// The longest first (long, bad, short), then plan order.
	assert.match(script, /^pending="3 4 2 1 5";/m);
	const cwd = mkdtempSync(join(tmpdir(), "plan-script-"));
	try {
		const result = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env: env() });
		assert.equal(result.status, 1, result.stdout);
		assert.match(result.stdout, /== changed: lint\nlint-ran\n== changed: lint passed in \d+ s\n/);
		// web's alone part ran in the first phase, its rest in the second; one block.
		assert.match(result.stdout, /== changed: web\nweb-alone\nweb-rest\n== changed: web passed in \d+ s\n/);
		assert.match(result.stdout, /== changed: bad\nbad-out\n== changed: bad FAILED after \d+ s\n/);
		assert.match(result.stdout, /== changed: long\nlong-done\n== changed: long passed in \d+ s\n/);
		// A failed alone part fails its step; its rest still runs.
		assert.match(result.stdout, /== changed: half\n== changed: half FAILED after \d+ s\n/);
		assert.match(result.stdout, /side by side within 2 cores: at most \d+ tasks of the runner user/);
		assert.equal(result.stdout.match(/^== changed: [a-z]+$/gm).length, steps.length);
		assert.deepEqual(readFileSync(join(cwd, ".run-on-node-status"), "utf8").trim().split("=")[1].split(",").sort(), ["bad", "half"]);
		// Never more than 2 cores at once, yet two at once (long beside bad); web's 2 cores alone.
		const events = readFileSync(join(cwd, "events"), "utf8").trim().split("\n");
		assert.equal(mostCores(events, { web: 2, short: 1, long: 1, bad: 1, half: 1 }), 2);
		assert.equal(events.length, 10);
		// Only a run-on-node run, which reads its slots' cores, marks when every step has started.
		assert.equal(existsSync(join(cwd, ALL_STARTED)), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("side by side within the cores the run's slots give it, read again as they grow", () => {
	const rest = (name, more) => `echo "start ${name}" >>events; ${more}; s=$?; echo "end ${name}" >>events; exit $s`;
	// The longest step starts alone in one slot's core, then a second slot frees (the file says 4).
	const grow = 'echo 4 >"$QORPERA_RUN_CORES_FILE.tmp" && mv -f "$QORPERA_RUN_CORES_FILE.tmp" "$QORPERA_RUN_CORES_FILE"; sleep 3';
	const steps = [
		{ name: "first", commands: [rest("first", grow)], seconds: 100 },
		...["b", "c", "d", "e"].map((name, i) => ({ name, commands: [rest(name, "sleep 2")], seconds: 50 - i })),
	];
	const cores = { first: 1, b: 1, c: 1, d: 1, e: 1 };
	const script = planScript(steps, { cores: 6 });
	const cwd = mkdtempSync(join(tmpdir(), "plan-script-"));
	try {
		writeFileSync(join(cwd, "cores"), "1\n");
		const result = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env: env(join(cwd, "cores")) });
		assert.equal(result.status, 0, result.stdout);
		assert.match(result.stdout, /side by side within 6 cores \(at most 4 from its slots\): at most \d+ tasks/);
		const events = readFileSync(join(cwd, "events"), "utf8").trim().split("\n");
		// first alone, then 3 more beside it within the 4 cores, never the 6 asked.
		assert.equal(events[0], "start first");
		assert.equal(events[1].startsWith("start "), true);
		assert.equal(mostCores(events, cores), 4);
		assert.equal(existsSync(join(cwd, ALL_STARTED)), true);
		// A cores file it cannot read keeps the budget at one core: the steps run one at a time.
		rmSync(join(cwd, "events"));
		rmSync(join(cwd, ALL_STARTED));
		const quick = steps.map((step) => ({ ...step, commands: [rest(step.name, "true")] }));
		const missing = spawnSync("bash", ["-c", planScript(quick, { cores: 6 })], { cwd, encoding: "utf8", env: env(join(cwd, "none")) });
		assert.equal(missing.status, 0, missing.stdout);
		assert.match(missing.stdout, /\(at most 1 from its slots\)/);
		assert.equal(mostCores(readFileSync(join(cwd, "events"), "utf8").trim().split("\n"), cores), 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("side by side: a worker killed, or one that cannot write its result, fails its step and the run still ends", () => {
	const steps = [
		{ name: "fine", commands: ["sleep 2", "echo fine-done"] },
		// Its rest's subshell kills the worker above it (field 4 of /proc/<pid>/stat is the parent).
		{ name: "killed", commands: ['read -r _ _ _ worker _ </proc/$BASHPID/stat', 'kill -9 "$worker"'] },
		// Its result cannot be written: the scheduler's temporary name for it (step 2) is a directory.
		{ name: "lost", commands: ['mkdir "$out/2.end.tmp"', "echo lost-ran"] },
	];
	const cwd = mkdtempSync(join(tmpdir(), "plan-script-"));
	try {
		// Before workers were reaped, this run never ended.
		const result = spawnSync("bash", ["-c", planScript(steps, { cores: 3 })], { cwd, encoding: "utf8", timeout: 30_000 });
		assert.equal(result.signal, null, result.stdout);
		assert.equal(result.status, 1, result.stdout);
		assert.match(result.stdout, /== changed: fine\nfine-done\n== changed: fine passed in \d+ s\n/);
		assert.match(result.stdout, /== changed: killed\n== changed: killed: its worker ended \(exit 137\) without a result\n== changed: killed FAILED after \d+ s\n/);
		assert.match(result.stdout, /== changed: lost\nlost-ran\n== changed: lost: its worker ended \(exit 1\) without a result\n== changed: lost FAILED after \d+ s\n/);
		assert.deepEqual(readFileSync(join(cwd, ".run-on-node-status"), "utf8").trim().split("=")[1].split(",").sort(), ["killed", "lost"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

/** Whether the process is gone: no longer in /proc, or a zombie nobody has reaped yet. */
function gone(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
	} catch {
		return true;
	}
}

test("fail-fast, one step at a time: the shortest first, and no step starts after a failure or once the stop file is there", () => {
	const steps = [
		{ name: "long", commands: ["echo long-ran"], seconds: 100 },
		{ name: "bad", commands: ["echo bad-ran", "false"], seconds: 5 },
		{ name: "short", commands: ["echo short-ran"], seconds: 1 },
		{ name: "after", commands: ["echo after-ran"], seconds: 50 },
	];
	const cwd = mkdtempSync(join(tmpdir(), "plan-script-"));
	const status = join(cwd, ".run-on-node-status");
	try {
		const run = (list) => spawnSync("bash", ["-c", planScript(list, { failFast: true })], { cwd, encoding: "utf8" });
		const failed = run(steps);
		assert.equal(failed.status, 1, failed.stdout);
		assert.match(
			failed.stdout,
			/^== changed: short\nshort-ran\n== changed: short passed in \d+ s\n== changed: bad\nbad-ran\n== changed: bad FAILED after \d+ s\n== changed: failed: bad\n== changed: stopped \(--fail-fast\): after long\n$/,
		);
		assert.equal(readFileSync(status, "utf8"), "failed_steps=bad\nstopped_steps=after,long\n");
		// Another part failed: no step starts.
		rmSync(status);
		const fine = steps.filter((step) => step.name !== "bad");
		writeFileSync(join(cwd, STOP), "");
		const stopped = run(fine);
		assert.equal(stopped.status, 1, stopped.stdout);
		assert.equal(stopped.stdout, "== changed: stopped (--fail-fast): short after long\n");
		assert.equal(readFileSync(status, "utf8"), "failed_steps=\nstopped_steps=short,after,long\n");
		rmSync(status);
		rmSync(join(cwd, STOP));
		const passed = run(fine);
		assert.equal(passed.status, 0, passed.stdout);
		assert.match(passed.stdout, /short-ran\n[^]*after-ran\n[^]*long-ran\n[^]*== changed: all steps passed\n$/);
		assert.equal(existsSync(status), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("fail-fast side by side: a failure ends the running steps' whole process trees and their containers, and starts no more", () => {
	const bin = mkdtempSync(join(tmpdir(), "plan-docker-"));
	const cwd = mkdtempSync(join(tmpdir(), "plan-script-"));
	try {
		// A stand-in docker lists, until removed: a container named after the stopped step's grandchild, one named after
		// another process, one binding a path in the run's directory and one binding a directory whose name only starts
		// like it. It logs what it is asked to remove. (bash starts in the physical directory.)
		const here = realpathSync(cwd);
		const inspect = {
			c1: `/qorpera-hosted-db-$(cat '${cwd}/grandchild.pid')-0123abcd`,
			c2: "/qorpera-hosted-db-1-0123abcd",
			c3: `/eager_turing /var/lib/docker/volumes/v/_data ${here}/crates/qorpera-folder`,
			c4: `/other ${here}-other`,
		};
		writeFileSync(
			join(bin, "docker"),
			[
				"#!/bin/sh",
				'case "$1" in',
				`ps) for c in c1 c2 c3 c4; do grep -qx "$c" '${cwd}/removed' 2>/dev/null || echo "$c"; done ;;`,
				`inspect) shift 3; for c in "$@"; do case "$c" in ${Object.entries(inspect).map(([id, rest]) => `${id}) echo "${id} ${rest}" ;;`).join(" ")} esac; done ;;`,
				`rm) echo "$*" >>'${cwd}/docker.log'; shift 3; for c in "$@"; do echo "$c" >>'${cwd}/removed'; done ;;`,
				"esac",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const steps = [
			// A child that starts a grandchild, both waiting; the step waits for the child.
			{ name: "slow", commands: ["sh -c 'sleep 60 & echo $! >grandchild.pid; wait' & echo $! >child.pid; wait"], seconds: 100 },
			{ name: "bad", commands: ["until [ -e grandchild.pid ]; do sleep 0.1; done; echo bad-out; false"], seconds: 50 },
			// No room for it beside the other two (2 cores).
			{ name: "later", commands: ["echo later-ran"], seconds: 1 },
		];
		const started = Date.now();
		const result = spawnSync("bash", ["-c", planScript(steps, { cores: 2, failFast: true })], {
			cwd,
			encoding: "utf8",
			env: { ...env(), PATH: `${bin}:${process.env.PATH}` },
			timeout: 30_000,
		});
		assert.equal(result.status, 1, result.stdout);
		// Long before the 60 s sleep would end.
		assert.ok(Date.now() - started < 20_000, String(Date.now() - started));
		assert.match(result.stdout, /== changed: bad\nbad-out\n== changed: bad FAILED after \d+ s\n== changed: slow stopped after \d+ s \(--fail-fast\)\n/);
		assert.doesNotMatch(result.stdout, /later-ran|== changed: (slow|later)\n/);
		assert.match(result.stdout, /== changed: failed: bad\n== changed: stopped \(--fail-fast\): slow later\n$/);
		assert.equal(readFileSync(join(cwd, ".run-on-node-status"), "utf8"), "failed_steps=bad\nstopped_steps=slow,later\n");
		for (const file of ["child.pid", "grandchild.pid"]) assert.ok(gone(Number(readFileSync(join(cwd, file), "utf8"))), file);
		// Once: the second look, after the trees are gone, finds none of the run's left.
		assert.equal(readFileSync(join(cwd, "docker.log"), "utf8"), "rm -f -v c1 c3\n");
	} finally {
		rmSync(bin, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

const dockerUsable = process.platform === "linux" && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

test("fail-fast side by side on docker: the containers of the stopped steps end with them, and no other", { skip: dockerUsable ? false : "needs Linux with Docker" }, () => {
	// In the repository, which is the run's directory when a run's step runs this test: the containers bind paths in
	// it, so a run that stops that step removes them too.
	const cwd = mkdtempSync(join(repositoryRoot, ".plan-script-"));
	const other = mkdtempSync(join(repositoryRoot, ".plan-other-"));
	const label = `qorpera.plan-test=${process.pid}-${Date.now()}`;
	const listed = () => spawnSync("docker", ["ps", "-aq", "--filter", `label=${label}`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
	const container = (args, command) => `docker run --rm --label ${label} --network none ${args} --entrypoint sh ${POSTGRES_IMAGE} -c '${command}'`;
	try {
		// Another run's: it binds a directory beside this run's, and outlives this run.
		const kept = spawnSync("bash", ["-c", container(`--detach -v ${other}:/w:ro`, "sleep 600")], { encoding: "utf8" });
		assert.equal(kept.status, 0, kept.stderr);
		const steps = [
			// folder-program's shape: attached, the run's directory bound, a shell as PID 1 that ignores the TERM the
			// client passes on.
			{ name: "program", commands: [`${container('-v "$PWD:/w:ro"', "sleep 600")} & echo $! >client.pid; wait`], seconds: 100 },
			// hosted-db's: detached, named after the process that started it.
			{ name: "db", commands: [`${container("--detach --name qorpera-hosted-db-$BASHPID-0123abcd", "sleep 600")} && sleep 600`], seconds: 90 },
			// Fails once the three containers run.
			{ name: "bad", commands: [`for _ in $(seq 600); do n=$(docker ps -q --filter label=${label} | wc -l); [ "$n" = 3 ] && break; sleep 0.1; done; echo "up: $n"; false`], seconds: 50 },
		];
		const started = Date.now();
		const result = spawnSync("bash", ["-c", planScript(steps, { cores: 3, failFast: true })], { cwd, encoding: "utf8", env: env(), timeout: 120_000 });
		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /== changed: bad\nup: 3\n== changed: bad FAILED after \d+ s\n/);
		assert.match(result.stdout, /== changed: failed: bad\n== changed: stopped \(--fail-fast\): program db\n$/);
		// Long before the 600 s sleeps would end.
		assert.ok(Date.now() - started < 60_000, String(Date.now() - started));
		assert.ok(gone(Number(readFileSync(join(cwd, "client.pid"), "utf8"))), "the docker client");
		assert.deepEqual(listed(), [kept.stdout.trim().slice(0, 12)]);
	} finally {
		const left = listed();
		if (left.length) spawnSync("docker", ["rm", "-f", "-v", ...left], { stdio: "ignore" });
		rmSync(cwd, { recursive: true, force: true });
		rmSync(other, { recursive: true, force: true });
	}
});

test("fail-fast side by side: an alone part that fails stops the rest at once, and so does the stop file", () => {
	const cwd = mkdtempSync(join(tmpdir(), "plan-script-"));
	const status = join(cwd, ".run-on-node-status");
	try {
		const run = (steps) => spawnSync("bash", ["-c", planScript(steps, { cores: 2, failFast: true })], { cwd, encoding: "utf8", env: env(), timeout: 30_000 });
		const alone = [
			{ name: "lint", commands: [], alone: ["echo lint-out", "false"] },
			{ name: "typecheck", commands: [], alone: ["echo typecheck-ran"] },
			{ name: "web", commands: ["echo web-rest"], alone: ["echo web-alone"] },
		];
		const lint = run(alone);
		assert.equal(lint.status, 1, lint.stdout);
		assert.match(lint.stdout, /^== changed: lint\nlint-out\n== changed: lint FAILED after \d+ s\n/);
		assert.doesNotMatch(lint.stdout, /typecheck-ran|web-alone|web-rest/);
		assert.match(lint.stdout, /== changed: failed: lint\n== changed: stopped \(--fail-fast\): typecheck web\n$/);
		assert.equal(readFileSync(status, "utf8"), "failed_steps=lint\nstopped_steps=typecheck,web\n");
		rmSync(status);
		// A step with a rest whose alone part failed fails without running its rest.
		const half = run([{ name: "half", commands: ["echo half-rest"], alone: ["false"] }, ...alone.slice(1)]);
		assert.equal(half.status, 1, half.stdout);
		assert.match(half.stdout, /^== changed: half\n== changed: half FAILED after \d+ s\n/);
		assert.doesNotMatch(half.stdout, /half-rest|typecheck-ran|web-alone|web-rest/);
		assert.equal(readFileSync(status, "utf8"), "failed_steps=half\nstopped_steps=typecheck,web\n");
		rmSync(status);
		// The stop file another part's failure leaves, here made by the running step itself: it stops, and the step
		// waiting for room (2 cores) never starts.
		const stopped = run([
			{ name: "slow", commands: [`touch ${STOP}; sleep 60`], seconds: 100 },
			{ name: "later", commands: ["echo later-ran"], seconds: 1, cores: 2 },
		]);
		assert.equal(stopped.status, 1, stopped.stdout);
		assert.match(stopped.stdout, /^== changed: slow stopped after \d+ s \(--fail-fast\)\n/);
		assert.doesNotMatch(stopped.stdout, /later-ran|failed:/);
		assert.match(stopped.stdout, /== changed: stopped \(--fail-fast\): slow later\n$/);
		assert.equal(readFileSync(status, "utf8"), "failed_steps=\nstopped_steps=slow,later\n");
		rmSync(status);
		// The stop file there from the start: not even an alone part runs.
		const none = run(alone.slice(1));
		assert.equal(none.status, 1, none.stdout);
		assert.doesNotMatch(none.stdout, /typecheck-ran|web-alone|web-rest|failed:/);
		assert.match(none.stdout, /== changed: stopped \(--fail-fast\): typecheck web\n$/);
		assert.equal(readFileSync(status, "utf8"), "failed_steps=\nstopped_steps=typecheck,web\n");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("side by side: a step's node --test and Go programs fan out within its cores, rounded up; one at a time as before", () => {
	// A stand-in node prints how it was called.
	const bin = mkdtempSync(join(tmpdir(), "plan-node-"));
	const cwd = mkdtempSync(join(tmpdir(), "plan-script-"));
	try {
		writeFileSync(join(bin, "node"), '#!/bin/sh\necho "node $* GOMAXPROCS=${GOMAXPROCS-unset}"\n', { mode: 0o755 });
		const steps = [
			{
				name: "wide",
				commands: [
					"node --test a.test.mjs b.test.mjs",
					"(cd / && node --test c.test.mjs)",
					"node tool.mjs --test",
					"sh -c 'node --test d.test.mjs'",
				],
				cores: 2.6,
			},
			{ name: "thin", commands: ["node --test e.test.mjs"], cores: 0.25 },
		];
		const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
		delete env.GOMAXPROCS;
		const side = spawnSync("bash", ["-c", planScript(steps, { cores: 4 })], { cwd, encoding: "utf8", env });
		assert.equal(side.status, 0, side.stdout);
		// A node --test the step's shell runs, in a subshell too; not another node command, nor one a script starts.
		assert.match(
			side.stdout,
			/== changed: wide\nnode --test --test-concurrency=3 a\.test\.mjs b\.test\.mjs GOMAXPROCS=3\nnode --test --test-concurrency=3 c\.test\.mjs GOMAXPROCS=3\nnode tool\.mjs --test GOMAXPROCS=3\nnode --test d\.test\.mjs GOMAXPROCS=3\n== changed: wide passed/,
		);
		assert.match(side.stdout, /== changed: thin\nnode --test --test-concurrency=1 e\.test\.mjs GOMAXPROCS=1\n== changed: thin passed/);
		const one = spawnSync("bash", ["-c", planScript(steps)], { cwd, encoding: "utf8", env });
		assert.equal(one.status, 0, one.stdout);
		assert.match(one.stdout, /== changed: wide\nnode --test a\.test\.mjs b\.test\.mjs GOMAXPROCS=unset\n/);
		assert.doesNotMatch(one.stdout, /--test-concurrency|GOMAXPROCS=[0-9]/);
	} finally {
		rmSync(bin, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("side by side: a step with workers runs its vitests with that many, unless the run set its own; one at a time as before", () => {
	// A stand-in node prints the vitest workers it was given.
	const bin = mkdtempSync(join(tmpdir(), "plan-node-"));
	const cwd = mkdtempSync(join(tmpdir(), "plan-script-"));
	try {
		writeFileSync(join(bin, "node"), '#!/bin/sh\necho "node $* workers=${VITEST_MAX_WORKERS-unset}"\n', { mode: 0o755 });
		const steps = [
			{ name: "busy", commands: ["node a.mjs", "(cd / && node b.mjs)"], cores: 3, workers: 4 },
			{ name: "plain", commands: ["node c.mjs"], cores: 1 },
		];
		const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, VITEST_MAX_WORKERS: "2" };
		const side = spawnSync("bash", ["-c", planScript(steps, { cores: 4 })], { cwd, encoding: "utf8", env });
		assert.equal(side.status, 0, side.stdout);
		assert.match(side.stdout, /== changed: busy\nnode a\.mjs workers=4\nnode b\.mjs workers=4\n== changed: busy passed/);
		assert.match(side.stdout, /== changed: plain\nnode c\.mjs workers=2\n== changed: plain passed/);
		// A VITEST_MAX_WORKERS the run was given (run-on-node --env) wins.
		const given = spawnSync("bash", ["-c", planScript(steps, { cores: 4, stepWorkers: false })], { cwd, encoding: "utf8", env: { ...env, VITEST_MAX_WORKERS: "3" } });
		assert.equal(given.status, 0, given.stdout);
		assert.match(given.stdout, /== changed: busy\nnode a\.mjs workers=3\nnode b\.mjs workers=3\n== changed: busy passed/);
		const one = spawnSync("bash", ["-c", planScript(steps)], { cwd, encoding: "utf8", env });
		assert.equal(one.status, 0, one.stdout);
		assert.match(one.stdout, /== changed: busy\nnode a\.mjs workers=2\nnode b\.mjs workers=2\n/);
		assert.doesNotMatch(one.stdout, /workers=4/);
	} finally {
		rmSync(bin, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
	// runner-orchestrator's rest, side by side: 4 workers in 3 cores (16 Oct measurement).
	const ro = planChanged(["packages/runner-orchestrator/src/cli.ts"]).steps.find((step) => step.name === "runner-orchestrator");
	assert.deepEqual([ro.cores, ro.workers], [3, 4]);
	assert.equal(planChanged(["packages/web/src/x.ts"]).steps.find((step) => step.name === "web").workers, null);
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

/** Every file under `directory`, by its path from `root`, outside node_modules and .git (vitest's default exclude). */
function filesUnder(root, directory = root) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === "node_modules" || entry.name === ".git") return [];
		const path = join(directory, entry.name);
		return entry.isDirectory() ? filesUnder(root, path) : [relative(root, path)];
	});
}

// Each step that runs the files that mostly wait beside the rest of its package (the step is named after the
// package), with the files that then run on their own, each in a vitest of its own.
for (const [name, waiting, alone] of [
	["runner-orchestrator", RUNNER_ORCHESTRATOR_WAITING, []],
	["runtime", RUNTIME_WAITING, ["test/cloud-coding-command-guest.test.ts"]],
]) {
	test(`${name}'s vitest runs together run every test file of the package exactly once`, () => {
		const root = join(repositoryRoot, "packages", name);
		for (const file of [...waiting, ...alone]) {
			assert.ok(existsSync(join(root, file)), file);
			// A plain path, so --exclude's glob matches only that file.
			assert.match(file, /^[a-z0-9/._-]+$/);
		}
		// vitest's default include, which the package's configuration keeps.
		const files = filesUnder(root).filter((file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
		assert.ok(files.length > waiting.length + alone.length);
		const step = STEPS.find((candidate) => candidate.name === name);
		const runs = [...step.commands.join("\n").matchAll(/vitest\/dist\/cli\.js --run([^)]*)\)/g)].map(([, args]) => args.trim());
		// The rest, the files that mostly wait, and each file that runs alone.
		assert.equal(runs.length, 2 + alone.length);
		const rest = runs.find((args) => args.startsWith("--exclude "));
		const excluded = [...rest.matchAll(/--exclude (\S+)/g)].map(([, file]) => file);
		assert.equal(rest, excluded.map((file) => `--exclude ${file}`).join(" "));
		assert.deepEqual(set(excluded), set([...waiting, ...alone]));
		const filtered = runs.filter((args) => args !== rest).map((args) => args.split(" "));
		assert.deepEqual(filtered.map(set), [set(waiting), ...alone.map((file) => [file])]);
		for (const file of files) {
			// --exclude drops the file at that exact path; a filter keeps every file whose path contains it, in lower case.
			const inRest = !excluded.includes(file);
			const inFiltered = filtered.filter((filters) => filters.some((filter) => file.toLowerCase().includes(filter.toLowerCase())));
			assert.equal(Number(inRest) + inFiltered.length, 1, file);
		}
	});

	test(`${name} fails before running anything when a file it runs beside the rest is missing`, () => {
		const step = STEPS.find((candidate) => candidate.name === name);
		assert.equal(spawnSync("bash", ["-c", step.commands[0]], { cwd: repositoryRoot }).status, 0);
		const root = mkdtempSync(join(tmpdir(), `${name}-waiting-`));
		try {
			mkdirSync(join(root, `packages/${name}/test`), { recursive: true });
			for (const file of waiting.slice(1)) writeFileSync(join(root, `packages/${name}`, file), "");
			const result = spawnSync("bash", ["-c", planScript([step])], { cwd: root, encoding: "utf8" });
			assert.equal(result.status, 1, result.stdout);
			assert.ok(result.stdout.includes(`== ${name}: ${waiting[0]} is missing`), result.stdout);
			assert.ok(result.stdout.includes(`== changed: ${name} FAILED`), result.stdout);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("beside runs two commands at once, prints the second's output after the first's, and fails when either fails", () => {
	const cwd = mkdtempSync(join(tmpdir(), "plan-beside-"));
	try {
		const run = (first, second) =>
			spawnSync("bash", ["-c", `set -u\n${beside(first, second, "second")}`], {
				cwd,
				encoding: "utf8",
				env: { ...process.env, TMPDIR: cwd },
				timeout: 20_000,
			});
		// Each waits for the other's file, so both end only when they run at the same time.
		const together = run(
			"touch first; until [ -e second ]; do sleep 0.01; done; echo first ran",
			"touch second; until [ -e first ]; do sleep 0.01; done; echo second ran",
		);
		assert.equal(together.status, 0, together.stdout);
		assert.equal(together.stdout, "first ran\n== second (ran beside)\nsecond ran\n");
		// The second's output file is removed.
		assert.deepEqual(readdirSync(cwd).sort(), ["first", "second"]);
		const firstFails = run("echo first ran; false", "echo second ran");
		assert.equal(firstFails.status, 1);
		assert.equal(firstFails.stdout, "first ran\n== second (ran beside)\nsecond ran\n");
		const secondFails = run("echo first ran", "echo second ran; exit 3");
		assert.equal(secondFails.status, 1);
		assert.equal(secondFails.stdout, "first ran\n== second (ran beside)\nsecond ran\n");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
