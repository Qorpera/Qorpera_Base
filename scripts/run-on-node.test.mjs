import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
	baseCopyCompare,
	CLOSED,
	CPU_SLOTS,
	candidateMachines,
	copyOptions,
	customTarget,
	DROPPED,
	describeProbes,
	EXTRA_MEMORY_MIB,
	EXTRA_PAUSE_SECONDS,
	EXTRA_PRESSURE,
	EXTRA_SLOTS,
	FRONT,
	firstTaking,
	GROW_MEMORY_MIB,
	growScript,
	includeRules,
	joinRecords,
	KEPT_SLOTS,
	MACHINES,
	parseArgs,
	parseSeed,
	parseStatus,
	pickSlot,
	probeAll,
	probeScript,
	pruneScript,
	QUEUED,
	QUICK_LIMIT_SECONDS,
	QUICK_SLOTS,
	RUNNERS,
	rankMachines,
	roomyScript,
	runCommandLine,
	runOrder,
	runScript,
	SET_UP,
	SLOT,
	SPREAD_MS,
	secretLooking,
	seedScript,
	shellQuote,
	suiteCommand,
	treeDigest,
	WIDE_SLOTS,
	wholeBlocks,
	workingTreeFiles,
	writeWhole,
} from "./run-on-node.mjs";

test("suites map to their commands", () => {
	assert.deepEqual(suiteCommand("test"), ["npm", "test"]);
	assert.deepEqual(suiteCommand("hosted-db"), ["npm", "run", "test:hosted-db"]);
	assert.deepEqual(suiteCommand("npm:test:scripts"), ["npm", "run", "test:scripts"]);
	assert.deepEqual(suiteCommand("scripts/test-office-preparation-linux.mjs"), [
		"node",
		"scripts/test-office-preparation-linux.mjs",
	]);
	for (const bad of ["../x.mjs", "scripts/a/b.mjs", "scripts/x.sh", "npm:a;b", "rm -rf"])
		assert.throws(() => suiteCommand(bad), /Unknown suite/);
});

test("options, install default and extra arguments", () => {
	const hosted = parseArgs(["hosted-db"]);
	assert.equal(hosted.install, false);
	assert.deepEqual(hosted.command, ["npm", "run", "test:hosted-db"]);
	const linux = parseArgs(["--env", "QORPERA_OFFICE_TEST_IMAGE=node:24", "--sudo", "scripts/x-linux.mjs", "--", "--fast"]);
	assert.equal(linux.install, true);
	assert.equal(linux.sudo, true);
	assert.deepEqual(linux.env, [["QORPERA_OFFICE_TEST_IMAGE", "node:24"]]);
	assert.deepEqual(linux.command, ["node", "scripts/x-linux.mjs", "--fast"]);
	assert.deepEqual(parseArgs(["--no-install", "--", "docker", "run", "--rm", "hello-world"]).command, [
		"docker",
		"run",
		"--rm",
		"hello-world",
	]);
	assert.equal(parseArgs(["--install", "hosted-db"]).install, true);
	assert.equal(parseArgs(["--allow-secrets", "hosted-db"]).allowSecrets, true);
	const whole = parseArgs(["test"]);
	assert.deepEqual([whole.install, whole.build], [true, true]);
	assert.deepEqual([linux.build, hosted.build], [false, false]);
	assert.equal(parseArgs(["--build", "hosted-db"]).install, true);
	assert.equal(parseArgs(["--no-build", "test"]).build, false);
	assert.throws(() => parseArgs(["--no-install", "--build", "test"]), /--build needs --install/);
	assert.deepEqual([parseArgs(["--no-install", "test"]).install, parseArgs(["--no-install", "test"]).build], [false, false]);
	assert.throws(() => parseArgs(["--base", "--octopus", "changed"]), /Invalid --base/);
	assert.equal(parseArgs(["--base", "origin/release/runtime-v150", "changed"]).base, "origin/release/runtime-v150");
	assert.equal(parseArgs(["--tree", "pr-loop", "changed"]).tree, "pr-loop");
	assert.equal(parseArgs(["changed"]).tree, null);
	for (const bad of ["../x", "a/b", ".hidden", "", "pr-loop.lock"]) assert.throws(() => parseArgs(["--tree", bad, "changed"]), /Invalid --tree/);
	assert.throws(() => parseArgs(["hosted-db", "extra"]), /after --/);
	assert.throws(() => parseArgs(["--env", "1BAD=x", "hosted-db"]), /Invalid --env/);
	assert.throws(() => parseArgs(["--bogus", "hosted-db"]), /Unknown option/);
	assert.throws(() => parseArgs(["--"]), /Usage/);
	assert.throws(() => parseArgs([]), /Usage/);
});

test("npm suites pass their arguments to the script, not to npm", () => {
	assert.deepEqual(parseArgs(["npm:test:scripts", "--", "--test-name-pattern=foo"]).command, [
		"npm",
		"run",
		"test:scripts",
		"--",
		"--test-name-pattern=foo",
	]);
	assert.deepEqual(parseArgs(["hosted-db", "--", "--x"]).command, ["npm", "run", "test:hosted-db", "--", "--x"]);
	assert.deepEqual(parseArgs(["npm:test:scripts"]).command, ["npm", "run", "test:scripts"]);
});

test("each run takes a free runner user and installs and runs as that user", () => {
	assert.equal(RUNNERS.length, 16);
	assert.deepEqual([RUNNERS[0], RUNNERS[15]], ["ci01", "ci16"]);
	const script = runScript({
		run: "R",
		runDir: "/home/tester/runs/R",
		treeDir: "/home/tester/trees/T",
		files: 3,
		copySeconds: 1.25,
		install: true,
		build: true,
		runCommand: "npm test -- --x 'a b'",
	});
	assert.equal(spawnSync("bash", ["-n", "-c", script]).status, 0);
	// The slot lock stays on fd 8 of the session, so it is held until the run ends.
	assert.match(script, /exec 8>"\/run\/lock\/qorpera-test-machine-\$candidate\.lock"/);
	assert.match(script, /flock -n 8; then runner=\$candidate/);
	assert.match(script, /for candidate in ci01 ci02 .* ci16; do/);
	assert.match(script, /sudo -n chown -R "\$runner:\$runner" \/home\/tester\/runs\/R \|\| exit 93/);
	assert.match(script, /sudo -n -u "\$runner" -H bash -c '/);
	const inner = script.slice(script.indexOf("bash -c '"));
	assert.ok(inner.indexOf("npm ci") < inner.indexOf("build:web-sdk") && inner.indexOf("build:web-sdk") < inner.indexOf("npm test"));
	assert.doesNotMatch(runScript({ run: "R", runDir: "/r", treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true" }), /npm ci|build:web-sdk/);
});

test("at most five runs execute at once, four without --front, in arrival order, with two vitest workers each", () => {
	assert.equal(CPU_SLOTS, 5);
	assert.equal(KEPT_SLOTS, 1);
	const script = runScript({ run: "R", runDir: "/r", treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true" });
	// The queue ticket sorts by arrival and stays locked by its waiting run (fd 7); only the first ticket
	// may take a slot; a ticket nobody holds belongs to a dead run and is dropped, whatever its pid became.
	assert.match(script, /ticket=\/run\/lock\/qorpera-test-machine-queue\/\$\(date \+%s%N\)-\$\$; exec 7>"\$ticket"; flock 7;/);
	assert.match(script, /if \[ "\$position" = 1 \]; then/);
	assert.match(script, /flock -n "\$t" true 2>\/dev\/null && rm -f "\$t"/);
	assert.doesNotMatch(script, /kill -0/);
	// A lock file that cannot be opened skips that candidate instead of reusing the previous descriptor. A slot's file
	// is opened for reading first: the kept slot's is root's and read-only.
	assert.match(
		script,
		/lock="\/run\/lock\/qorpera-test-machine-slot\$candidate\.lock"; \{ exec 9<"\$lock" \|\| exec 9>"\$lock"; \} 2>\/dev\/null \|\| continue/,
	);
	assert.match(script, /\{ exec 8>"\/run\/lock\/qorpera-test-machine-\$candidate\.lock"; \} 2>\/dev\/null \|\| continue/);
	// A killed run's leftovers under the runner user are ended once its lock is held.
	assert.match(script, /sudo -n pkill -KILL -u "\$runner"/);
	// Without --front, slots 1-4: the fifth is kept for --front runs.
	assert.match(script, /for candidate in \$\(seq 1 4\); do/);
	assert.match(script, /waiting for a slot in the CPU lane \(4 runs at a time, 1 more slot kept for --front runs\), queue position \$position/);
	assert.match(script, /in slot \$slot of 7 in the CPU lane \(/);
	// The slot is taken before the runner user, and both stay locked for the session (fds 9 and 8).
	assert.ok(script.indexOf("qorpera-test-machine-slot") < script.indexOf("qorpera-test-machine-$candidate"));
	// vCPUs / 5 workers per run (2 on 10 or 12 vCPUs), at least 1.
	assert.match(script, /export VITEST_MAX_WORKERS=\$\(\( \$\(nproc\) \/ 5 > 0 \? \$\(nproc\) \/ 5 : 1 \)\)/);
	for (const [cpus, workers] of [[6, 1], [10, 2], [12, 2], [2, 1]])
		assert.equal(spawnSync("bash", ["-c", `echo $(( ${cpus} / 5 > 0 ? ${cpus} / 5 : 1 ))`], { encoding: "utf8" }).stdout.trim(), String(workers));
	assert.match(parseArgs(["--sudo", "--", "npm", "test"]).command.join(" "), /npm test/);
});

test("a hosted-db run narrowed with --only takes the quick lane", () => {
	assert.equal(QUICK_SLOTS, 2);
	assert.equal(parseArgs(["hosted-db", "--", "--only", "001"]).quick, true);
	assert.equal(parseArgs(["hosted-db", "--", "--only=001"]).quick, true);
	assert.equal(parseArgs(["--machine", "node01", "hosted-db", "--", "--scripts", "--only", "001,002"]).quick, true);
	assert.equal(parseArgs(["hosted-db"]).quick, false);
	assert.equal(parseArgs(["hosted-db", "--", "--scripts"]).quick, false);
	assert.equal(parseArgs(["changed"]).quick, false);
	assert.equal(parseArgs(["test"]).quick, false);
	assert.equal(parseArgs(["npm:test:scripts", "--", "--only", "001"]).quick, false);
	assert.equal(parseArgs(["--", "npm", "run", "test:hosted-db", "--", "--only", "001"]).quick, false);
});

test("--quick takes the quick lane with a time limit, for one short command", () => {
	const options = parseArgs(["--quick", "--", "node", "--test", "scripts/x.test.mjs"]);
	assert.deepEqual([options.quick, options.limit, options.plain], [true, QUICK_LIMIT_SECONDS, false]);
	assert.equal(parseArgs(["--quick", "npm:test:scripts"]).quick, true);
	// A suite named with --quick does not speak for the suite on the commit: it may have been stopped at the limit.
	assert.equal(parseArgs(["--quick", "npm:test:scripts"]).plain, false);
	assert.equal(parseArgs(["hosted-db", "--", "--only", "001"]).limit, null);
	assert.equal(parseArgs(["--", "true"]).limit, null);
	assert.throws(() => parseArgs(["--quick", "changed"]), /--quick is for one short command, not for changed/);
	assert.throws(() => parseArgs(["--quick", "--front", "--", "true"]), /--front is for the CPU lane; a --quick run has the quick lane/);
	assert.equal(runCommandLine({ command: ["true"], limit: 180 }), "timeout --kill-after=10 180 true");
	assert.equal(runCommandLine({ command: ["true"] }), "true");
	// A real stop, with the run's own line: exit 124 at the limit, and the suite's own exit otherwise.
	const inner = (limit, command) => {
		const script = runScript({ run: "R", runDir: "/r", treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: runCommandLine({ command, limit }), quick: true, limit });
		// What the session runs as the runner user, from the command on (its status file is not there: that line only complains).
		const from = script.indexOf("start=$(date +%s%N);");
		const body = script.slice(from, script.lastIndexOf("exit $code") + "exit $code".length).replaceAll(`'\\''`, "'");
		return spawnSync("bash", ["-c", body], { encoding: "utf8" });
	};
	const stopped = inner(1, ["sleep", "30"]);
	assert.equal(stopped.status, 124);
	assert.match(stopped.stdout, /stopped at the quick lane's limit of 1 s: run it without --quick/);
	const failed = inner(30, ["bash", "-c", "exit 3"]);
	assert.equal(failed.status, 3);
	assert.doesNotMatch(failed.stdout, /quick lane's limit/);
});

test("a quick run queues for the quick slots only, a normal run for the CPU slots only, with the same logic", () => {
	const base = { run: "R", runDir: "/r", treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true" };
	const quick = runScript({ ...base, quick: true });
	const cpu = runScript({ ...base, quick: false });
	assert.equal(spawnSync("bash", ["-n", "-c", quick]).status, 0);
	assert.match(quick, /ticket=\/run\/lock\/qorpera-test-machine-quick-queue\/\$\(date \+%s%N\)-\$\$; exec 7>"\$ticket"; flock 7;/);
	assert.match(quick, /for t in \/run\/lock\/qorpera-test-machine-quick-queue\/\*; do/);
	assert.match(quick, /position=\$\(ls \/run\/lock\/qorpera-test-machine-quick-queue \| sort/);
	assert.match(
		quick,
		/lock="\/run\/lock\/qorpera-test-machine-quick-slot\$candidate\.lock"; \{ exec 9<"\$lock" \|\| exec 9>"\$lock"; \} 2>\/dev\/null \|\| continue/,
	);
	assert.match(quick, /for candidate in \$\(seq 1 2\); do/);
	assert.match(quick, /waiting for a slot in the quick lane \(2 runs at a time\), queue position \$position/);
	assert.match(quick, /in slot \$slot of 2 in the quick lane \(/);
	assert.doesNotMatch(quick, /qorpera-test-machine-(queue|slot)|CPU lane/);
	assert.match(cpu, /ticket=\/run\/lock\/qorpera-test-machine-queue\//);
	assert.match(cpu, /lock="\/run\/lock\/qorpera-test-machine-slot\$candidate\.lock"/);
	assert.doesNotMatch(cpu, /quick/);
	// Only the lane's names and slot counts differ; the runner user and everything after the slot are shared.
	const neutral = (script, lane, slots) =>
		script
			// The extra slots are the CPU lane's only.
			.replace(`${roomyScript()}\n`, "")
			.replace(/\t\tif \[ -z "\$slot" \] && roomy; then\n[\s\S]*?\n\t\tfi\n/, "")
			.replaceAll(`qorpera-test-machine-${lane}queue`, "QUEUE")
			.replaceAll(`qorpera-test-machine-${lane}slot`, "SLOT")
			.replaceAll(`seq 1 ${slots}`, "seq 1 N")
			.replace(/in the (quick|CPU) lane \([^)]*\)/, "LANE")
			.replace(/of \d+ in the (quick|CPU) lane/, "LANE");
	assert.equal(neutral(quick, "quick-", QUICK_SLOTS), neutral(cpu, "", CPU_SLOTS - KEPT_SLOTS));
	for (const script of [quick, cpu]) {
		assert.match(script, /flock -n "\$t" true 2>\/dev\/null && rm -f "\$t"/);
		assert.match(script, /if \[ "\$position" = 1 \]; then/);
		assert.match(script, /-ge 7200 \] && \{ echo "== run-on-node: no slot free for two hours"; exit 94; \}/);
	}
});

test("past the CPU lane's slots, the first run in the queue takes an extra one only while the machine has room", () => {
	const base = { run: "R", runDir: "/r", treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true" };
	const cpu = runScript(base);
	assert.equal(spawnSync("bash", ["-n", "-c", cpu]).status, 0);
	// After the lane's own slots, for the run the queue has come to, and only slots 6 and 7.
	const first = cpu.indexOf('if [ "$position" = 1 ]; then');
	const own = cpu.indexOf(`for candidate in $(seq 1 ${CPU_SLOTS - KEPT_SLOTS}); do`);
	const extra = cpu.indexOf('if [ -z "$slot" ] && roomy; then');
	const after = cpu.indexOf('if [ -z "$slot" ]; then', first);
	assert.ok(first < own && own < extra && extra < after);
	assert.equal(EXTRA_SLOTS, 2);
	assert.match(cpu, /for candidate in \$\(seq 6 7\); do\n\t+lock="\/run\/lock\/qorpera-test-machine-slot\$candidate\.lock"/);
	assert.match(cpu, /slot=\$candidate; touch \/run\/lock\/qorpera-test-machine-extra-started; break;/);
	assert.doesNotMatch(runScript({ ...base, quick: true }), /roomy|extra-started/);
	// A --front run may take one too, after every slot of its own.
	assert.match(runScript({ ...base, front: true }), /if \[ -z "\$slot" \] && roomy; then/);

	const temporary = mkdtempSync(join(tmpdir(), "run-on-node-test-"));
	try {
		const meminfo = join(temporary, "meminfo");
		const pressure = join(temporary, "pressure");
		const started = join(temporary, "started");
		const roomy = () => spawnSync("bash", ["-c", `${roomyScript({ meminfo, pressure, started })}\nroomy`]).status === 0;
		const write = (mib, some) => {
			writeFileSync(meminfo, `MemTotal:       16293124 kB\nMemAvailable:   ${mib * 1024} kB\n`);
			writeFileSync(pressure, `some avg10=99.00 avg60=${some}.50 avg300=31.51 total=28129063948\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`);
		};
		write(EXTRA_MEMORY_MIB, EXTRA_PRESSURE - 1);
		assert.equal(roomy(), true);
		write(EXTRA_MEMORY_MIB - 1, EXTRA_PRESSURE - 1);
		assert.equal(roomy(), false, "too little memory");
		write(EXTRA_MEMORY_MIB, EXTRA_PRESSURE);
		assert.equal(roomy(), false, "too much pressure");
		write(EXTRA_MEMORY_MIB, EXTRA_PRESSURE - 1);
		writeFileSync(started, "");
		assert.equal(roomy(), false, "one started just now");
		const long = new Date(Date.now() - (EXTRA_PAUSE_SECONDS + 5) * 1000);
		utimesSync(started, long, long);
		assert.equal(roomy(), true);
		// What it cannot read means no room.
		rmSync(pressure);
		assert.equal(roomy(), false, "no pressure file");
		write(EXTRA_MEMORY_MIB, EXTRA_PRESSURE - 1);
		rmSync(meminfo);
		assert.equal(roomy(), false, "no meminfo");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("--cores runs changed's steps side by side and is only for changed", () => {
	assert.equal(parseArgs(["changed"]).cores, null);
	const options = parseArgs(["--front", "--cores", "6", "changed"]);
	assert.deepEqual([options.cores, options.front, options.plain], [6, true, true]);
	for (const value of ["0", "x", "1.5", "100", "-2"]) assert.throws(() => parseArgs(["--cores", value, "changed"]), /Invalid --cores/, value);
	assert.throws(() => parseArgs(["--cores"]), /--cores needs a value/);
	assert.throws(() => parseArgs(["--cores", "4", "test"]), /--cores is for changed/);
	assert.throws(() => parseArgs(["--cores", "4", "--", "true"]), /--cores is for changed/);
});

test("--parts splits changed over the machines, at most one part each, and is only for changed", () => {
	assert.equal(parseArgs(["changed"]).parts, null);
	const options = parseArgs(["--front", "--cores", "6", "--parts", "2", "changed"]);
	assert.deepEqual([options.parts, options.cores, options.front, options.plain], [2, 6, true, true]);
	assert.equal(parseArgs(["--parts", "1", "changed"]).parts, 1);
	for (const value of ["0", "x", "1.5", String(MACHINES.length + 1), "-2", "10"])
		assert.throws(() => parseArgs(["--parts", value, "changed"]), /Invalid --parts/, value);
	assert.throws(() => parseArgs(["--parts"]), /--parts needs a value/);
	assert.throws(() => parseArgs(["--parts", "2", "test"]), /--parts is for changed/);
	assert.throws(() => parseArgs(["--parts", "2", "--", "true"]), /--parts is for changed/);
});

test("--fail-fast is only for changed, and a fail-fast run still speaks for the suite", () => {
	assert.equal(parseArgs(["changed"]).failFast, false);
	const options = parseArgs(["--front", "--cores", "6", "--parts", "2", "--fail-fast", "changed"]);
	assert.deepEqual([options.failFast, options.parts, options.plain], [true, 2, true]);
	assert.throws(() => parseArgs(["--fail-fast", "test"]), /--fail-fast is for changed/);
	assert.throws(() => parseArgs(["--fail-fast", "--", "true"]), /--fail-fast is for changed/);
});

test("a run in parts passes only when every part passed; a part that ran no steps never lets another's result stand for it", () => {
	const order = ["lint", "hosted-db", "runtime", "scripts", "runner-orchestrator"];
	const part = (k, result, extra = {}) => ({
		machine: k === 1 ? "node02" : "node01",
		run: `20261016T030000-1-ab-p${k}`,
		runner: `ci0${k}`,
		exitCode: result === "passed" ? 0 : 1,
		result,
		...extra,
	});
	const common = { order, source: { head: "abc" }, lane: "cpu", changed: { steps: order }, elapsedSeconds: 301 };
	const passed = joinRecords([part(1, "passed"), part(2, "passed")], common);
	assert.deepEqual(
		{ ...passed, parts: passed.parts.map((one) => one.run) },
		{
			schema: "qorpera.run-on-node/v1",
			machine: "node02+node01",
			run: "20261016T030000-1-ab-p1+20261016T030000-1-ab-p2",
			runner: "ci01+ci02",
			source: { head: "abc" },
			lane: "cpu",
			changed: { steps: order },
			elapsedSeconds: 301,
			exitCode: 0,
			result: "passed",
			parts: ["20261016T030000-1-ab-p1", "20261016T030000-1-ab-p2"],
		},
	);
	// One part's machine died or its session was cut (ssh 255, no status read back): the run fails as the harness's,
	// whether the other part passed or failed a step, and names no failed step.
	const died = part(2, "setup-failed", { exitCode: 255, runner: null });
	const diedBeside = (other) => {
		const run = joinRecords([other, died], common);
		return [run.result, run.exitCode, run.failedSteps, run.runner];
	};
	assert.deepEqual(diedBeside(part(1, "passed")), ["setup-failed", 255, undefined, "ci01+none"]);
	const failedBeside = diedBeside(part(1, "failed", { failedSteps: ["hosted-db"] }));
	assert.deepEqual(failedBeside, ["setup-failed", 255, undefined, "ci01+none"]);
	assert.deepEqual(joinRecords([part(1, "install-failed", { exitCode: 90 }), part(2, "passed")], common).result, "install-failed");
	// The part that went worst gives the run its result and exit code, in either order of the parts: the harness's own
	// failure (a queue that timed out; no result read back) before npm ci or the build, and that before a failed step.
	const bothOrders = (a, b) => {
		const runs = [joinRecords([a, b], common), joinRecords([b, a], common)];
		return runs.map((run) => [run.result, run.exitCode, run.failedSteps]);
	};
	const install = part(1, "install-failed", { exitCode: 90 });
	const timedOut = part(2, "setup-failed", { exitCode: 94, runner: null });
	const noResult = part(2, "unknown", { exitCode: 0, runner: null });
	const failedStep = part(2, "failed", { failedSteps: ["hosted-db"] });
	const twice = (result, exitCode) => [
		[result, exitCode, undefined],
		[result, exitCode, undefined],
	];
	assert.deepEqual(bothOrders(install, timedOut), twice("setup-failed", 94));
	assert.deepEqual(bothOrders(install, died), twice("setup-failed", 255));
	assert.deepEqual(bothOrders(failedStep, died), twice("setup-failed", 255));
	assert.deepEqual(bothOrders(noResult, timedOut), twice("setup-failed", 94));
	assert.deepEqual(bothOrders(install, noResult), twice("unknown", 1));
	assert.deepEqual(bothOrders(install, failedStep), twice("install-failed", 90));
	// A part with no result (exit 0, no runner) is no pass, and the run exits non-zero.
	const unknown = joinRecords([part(1, "passed"), part(2, "unknown", { exitCode: 0, runner: null })], common);
	assert.deepEqual([unknown.result, unknown.exitCode], ["unknown", 1]);
	// One part failed a step: that step. Both did: every failed step, in plan order.
	const one = joinRecords([part(1, "passed"), part(2, "failed", { failedSteps: ["hosted-db"] })], common);
	assert.deepEqual([one.result, one.exitCode, one.failedSteps], ["failed", 1, ["hosted-db"]]);
	const both = joinRecords([part(1, "failed", { failedSteps: ["runner-orchestrator"] }), part(2, "failed", { failedSteps: ["scripts", "lint"] })], common);
	assert.deepEqual([both.result, both.failedSteps], ["failed", ["lint", "scripts", "runner-orchestrator"]]);
	// A failed part that names no step was cut off mid-way: the run names none either, as a single run cut off does, so
	// no list of known reds can pass it.
	const cut = joinRecords([part(1, "failed", { failedSteps: ["hosted-db"] }), part(2, "failed", { exitCode: 255 })], common);
	assert.deepEqual([cut.result, cut.exitCode, cut.failedSteps], ["failed", 1, undefined]);
	// --fail-fast: a part the other's failure stopped names the steps it stopped; both lists in plan order.
	const stopped = joinRecords(
		[part(1, "failed", { stoppedSteps: ["runner-orchestrator"] }), part(2, "failed", { failedSteps: ["hosted-db"], stoppedSteps: ["scripts", "runtime"] })],
		{ ...common, failFast: true },
	);
	assert.deepEqual(
		[stopped.result, stopped.exitCode, stopped.failedSteps, stopped.stoppedSteps, stopped.failFast],
		["failed", 1, ["hosted-db"], ["runtime", "scripts", "runner-orchestrator"], true],
	);
	assert.equal(joinRecords([part(1, "failed", { stoppedSteps: ["runtime"] }), part(2, "failed", { exitCode: 255 })], common).stoppedSteps, undefined);
	assert.equal(one.stoppedSteps, undefined);
	// Each part's own record is kept; with no runner in any part, none.
	assert.deepEqual(one.parts.map((record) => record.result), ["passed", "failed"]);
	assert.equal(joinRecords([part(1, "setup-failed", { runner: null }), part(2, "setup-failed", { runner: null })], common).runner, null);
});

test("a run in parts prints each part's output a whole step at a time, so steps of two parts never interleave", () => {
	const writes = [];
	const out = wholeBlocks((text) => writes.push(text));
	out.push("== run-on-node: in slot 1 of 5\n== changed: li");
	out.push("nt\nchecked 10 files\n");
	assert.deepEqual(writes, ["== run-on-node: in slot 1 of 5\n"]);
	out.push("== changed: lint passed in 2 s\n== changed: runtime\n ✓ one\n");
	assert.deepEqual(writes.splice(0), ["== run-on-node: in slot 1 of 5\n", "== changed: lint\nchecked 10 files\n== changed: lint passed in 2 s\n"]);
	// Another step's end, or a line that only mentions this one's, stays in the block; the end may follow output
	// that had no newline.
	out.push("== changed: lint passed in 1 s\nit said == changed: runtime FAILED after 3 s, twice\nlast words== changed: runtime FAILED after 40 s\nafter");
	assert.deepEqual(writes.splice(0), [
		"== changed: runtime\n ✓ one\n== changed: lint passed in 1 s\nit said == changed: runtime FAILED after 3 s, twice\nlast words== changed: runtime FAILED after 40 s\n",
	]);
	// The plan's own lines are not steps.
	out.push("\n== changed: side by side within 6 cores: at most 1 tasks\n== changed: scripts\n ✓ two\n");
	assert.deepEqual(writes.splice(0), ["after\n", "== changed: side by side within 6 cores: at most 1 tasks\n"]);
	// What is left at the end (a step cut off, a last line without its newline) is handed on.
	out.push("cut");
	out.end();
	assert.deepEqual(writes.splice(0), ["== changed: scripts\n ✓ two\ncut"]);
	out.end();
	assert.deepEqual(writes, []);
});

test("a --front --cores run takes up to three slots, one such run per machine; any other --cores run keeps its slot's cores", () => {
	assert.equal(WIDE_SLOTS, 3);
	const run = "20261016T001500-1-ab";
	const base = { run, runDir: `/home/tester/runs/${run}`, treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true" };
	const wide = runScript({ ...base, front: true, cores: 6 });
	const narrow = runScript({ ...base, cores: 6 });
	for (const script of [wide, narrow]) {
		assert.equal(spawnSync("bash", ["-n", "-c", script]).status, 0);
		// The steps read the run's cores file (planScript): one slot's cores at first, removed when the session ends.
		assert.match(script, /\nexport QORPERA_RUN_CORES_FILE=\/run\/lock\/qorpera-test-machine-cores-20261016T001500-1-ab\n/);
		assert.match(
			script,
			/\nper=\$\(\( \$\(nproc\) \/ 5 > 0 \? \$\(nproc\) \/ 5 : 1 \)\); cores_file=\/run\/lock\/qorpera-test-machine-cores-20261016T001500-1-ab; \(umask 022; echo "\$per" >"\$cores_file"\); trap 'rm -f "\$ticket" "\$cores_file"' EXIT\n/,
		);
		// Before the command, after the slot and the runner user.
		assert.ok(script.indexOf("cores_file=") > script.indexOf("in slot $slot of 7"));
		assert.ok(script.indexOf("cores_file=") < script.indexOf('sudo -n -u "$runner"'));
		assert.doesNotMatch(script, /kill -0/);
	}
	// Only a front run takes the machine's wide lock, without waiting, and grows; any other keeps its one slot.
	assert.match(
		wide,
		/\n\tif \{ exec 6>"\/run\/lock\/qorpera-test-machine-wide\.lock"; \} 2>\/dev\/null && flock -n 6; then echo "== run-on-node: side by side in up to \$want slots of \$per cores, taking the others as they free"; exec 4> >\(grow\)\n\telse echo "== run-on-node: another --front run holds this machine's extra slots: side by side in this one slot \(\$per cores\)"; fi\n/,
	);
	assert.ok(wide.includes(growScript({ allStarted: `/home/tester/runs/${run}/.run-on-node-all-started` })));
	assert.doesNotMatch(narrow, /grow|wide\.lock|want=/);
	// Without --cores nothing of it.
	for (const script of [runScript({ ...base, front: true }), runScript(base)]) assert.doesNotMatch(script, /cores|grow|wide|want=/);
	// The slots it wants: the cores asked over one slot's (vCPUs / 5), rounded up, at most WIDE_SLOTS.
	for (const [asked, cpus, slots] of [[6, 10, 3], [4, 10, 2], [3, 10, 2], [2, 10, 1], [1, 10, 1], [16, 12, 3], [6, 6, 3]]) {
		const lines = runScript({ ...base, front: true, cores: asked }).split("\n");
		const per = lines.find((line) => line.startsWith("per=")).split(";")[0].replaceAll("$(nproc)", String(cpus));
		const want = lines.find((line) => line.startsWith("want="));
		assert.equal(spawnSync("bash", ["-c", `${per}; ${want}; echo $want`], { encoding: "utf8" }).stdout.trim(), String(slots), `${asked} of ${cpus}`);
	}
	// A killed run's cores file is pruned by the time in its name, like the copy markers.
	assert.match(
		pruneScript(),
		/\nfor f in \/run\/lock\/qorpera-test-machine-cores-\*; do n=\$\{f#\/run\/lock\/qorpera-test-machine-cores-\}; if \[\[ "\$n" =~ \^\[0-9\]\{8\}T\[0-9\]\{6\}- && "\$\{n%%-\*\}" < "\$cutoff" \]\]; then rm -f -- "\$f"; fi; done\n/,
	);
});

test("--sudo hands the command the vitest workers and a --cores run's cores file, which sudo would drop", () => {
	const command = ["bash", "-c", 'echo "$VITEST_MAX_WORKERS ${QORPERA_RUN_CORES_FILE-none} $X"'];
	// A stand-in for sudo's env_reset: the command sees only what its line names.
	const run = (line) =>
		spawnSync("bash", ["-c", `sudo() { [ "$1" = -n ] && shift; env -i "$@"; }; export VITEST_MAX_WORKERS=2 QORPERA_RUN_CORES_FILE=/run/lock/c X=lost; ${line}`], {
			encoding: "utf8",
		}).stdout.trim();
	const sudoCores = { ...parseArgs(["--sudo", "--env", "X=a b", "--cores", "6", "changed"]), command };
	assert.equal(run(runCommandLine(sudoCores)), "2 /run/lock/c a b");
	assert.equal(run(runCommandLine({ ...parseArgs(["--sudo", "--env", "X=a b", "changed"]), command })), "2 none a b");
	assert.equal(run(runCommandLine({ ...parseArgs(["--env", "X=a b", "--cores", "6", "changed"]), command })), "2 /run/lock/c a b");
	assert.equal(runCommandLine({ command: ["npm", "test"] }), "npm test");
});

test("a --front run waits ahead of every other run in the CPU lane, front runs among themselves by arrival", () => {
	assert.equal(parseArgs(["changed"]).front, false);
	assert.equal(parseArgs(["--front", "--tree", "pr-loop", "--no-status", "changed"]).front, true);
	assert.equal(parseArgs(["--front", "hosted-db"]).front, true);
	assert.throws(() => parseArgs(["--front", "hosted-db", "--", "--only", "001"]), /--front is for the CPU lane/);
	const base = { run: "R", runDir: "/r", treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true" };
	const front = runScript({ ...base, front: true });
	const normal = runScript(base);
	assert.equal(spawnSync("bash", ["-n", "-c", front]).status, 0);
	assert.equal(FRONT, "0-");
	assert.match(front, /ticket=\/run\/lock\/qorpera-test-machine-queue\/0-\$\(date \+%s%N\)-\$\$; exec 7>"\$ticket"; flock 7;/);
	assert.match(front, /in slot \$slot of 7 in the CPU lane from the front of its queue \(/);
	assert.doesNotMatch(normal.replace("kept for --front runs", ""), /queue\/0-|front/);
	// It tries every slot, the kept one first; any other run only those before it.
	assert.match(front, /for candidate in \$\(seq 5 -1 1\); do/);
	assert.match(front, /waiting for a slot in the CPU lane \(5 runs at a time\), queue position \$position/);
	// Only the ticket's name, the slots it tries and the lines that say so differ: the same slot wait, the same position-1 rule.
	assert.equal(
		front
			.replace("queue/0-$(date", "queue/$(date")
			.replace(" from the front of its queue", "")
			.replace("seq 5 -1 1", "seq 1 4")
			.replace("(5 runs at a time)", "(4 runs at a time, 1 more slot kept for --front runs)"),
		normal,
	);
	// The wait's own order (ls | sort, then the ticket's line): front tickets first, in any collation, then the rest.
	const dir = mkdtempSync(join(tmpdir(), "run-on-node-queue-"));
	try {
		for (const name of ["1760650000000000000-900", "0-1760650000000000002-12", "1760640000000000000-31", "0-1760650000000000001-7777"])
			writeFileSync(join(dir, name), "");
		for (const locale of ["C", "C.UTF-8", "en_US.UTF-8"]) {
			const sorted = spawnSync("bash", ["-c", `ls ${shellQuote(dir)} | sort`], { encoding: "utf8", env: { ...process.env, LC_ALL: locale } });
			assert.deepEqual(
				sorted.stdout.trim().split("\n"),
				["0-1760650000000000001-7777", "0-1760650000000000002-12", "1760640000000000000-31", "1760650000000000000-900"],
				locale,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a front run goes to the machine with the fewest runs in its slots and front runs waiting, however long its queue", () => {
	const idle = (name) => ({ name, busy: 0, waiting: 0, quickBusy: 0, quickWaiting: 0, arriving: 0, frontWaiting: 0, closed: false, setUp: true, cpus: 10, load: 0.1 });
	const names = (probes, front) => rankMachines(probes, false, false, front).map((probe) => probe.name);
	// The first batch's probe (15 Oct, 23:18Z): node02 had a free slot behind 12 waiting runs.
	const probes = [{ ...idle("node02"), busy: 4, waiting: 12, quickBusy: 1 }, { ...idle("node01"), busy: 5, waiting: 6 }];
	assert.deepEqual(runOrder(probes, false, false, true), ["node02", "node01"]);
	assert.deepEqual(runOrder(probes, false, false), ["node01", "node02"]);
	// Front runs already waiting count against a machine; copies still arriving queue behind the front run.
	assert.deepEqual(names([{ ...idle("node02"), busy: 4, waiting: 2, frontWaiting: 2 }, { ...idle("node01"), busy: 5, waiting: 9, arriving: 3 }], true), [
		"node01",
		"node02",
	]);
	assert.deepEqual(names([{ ...idle("node02"), busy: 5 }, { ...idle("node01"), busy: 5 }], true), ["node02", "node01"]);
	assert.deepEqual(names([{ ...idle("node02"), busy: 5 }, { ...idle("node01"), closed: true }], true), ["node02"]);
	assert.equal(
		describeProbes([{ ...idle("node02"), busy: 5, waiting: 3, frontWaiting: 1 }]),
		"node02 5/5 slots busy, 3 waiting (1 at the front), quick 0/2",
	);
	// The kept slot counts for front runs only: four busy runs, one of them in the kept slot, leave a run without
	// --front one slot on node02 and none on node01; a front run one on each.
	const kept = [
		{ ...idle("node01"), busy: 4 },
		{ ...idle("node02"), busy: 4, keptBusy: 1 },
	];
	assert.deepEqual(runOrder(kept, false, false), ["node02", "node01"]);
	assert.deepEqual(names(kept, true), ["node01", "node02"]);
	// A machine whose four other slots are busy has none for a run without --front, however free the kept one.
	assert.deepEqual(names([{ ...idle("node02"), busy: 4 }, { ...idle("node01"), busy: 4, keptBusy: 1, waiting: 0 }], false), ["node01", "node02"]);
	assert.equal(describeProbes([kept[1]]), "node02 4/5 slots busy (1 kept for --front runs), 0 waiting, quick 0/2");
});

test("one test machine per node, each with its own address and so its own host key", () => {
	assert.deepEqual(
		MACHINES.map((machine) => machine.name),
		["node02", "node01"],
	);
	for (const field of ["name", "host", "jump"])
		assert.equal(new Set(MACHINES.map((machine) => machine[field])).size, MACHINES.length, field);
	// Every node's bridge is testmach0 10.201.0.0/24 (the guest guard's subnet); .1 is the node itself.
	for (const machine of MACHINES) assert.match(machine.host, /^tester@10\.201\.0\.([2-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])$/);
});

test("--machine picks one machine; QORPERA_TEST_MACHINE* replaces the list", () => {
	assert.equal(parseArgs(["--machine", "node01", "hosted-db"]).machine, "node01");
	assert.equal(parseArgs(["--machine", "node02", "changed"]).machine, "node02");
	assert.equal(parseArgs(["hosted-db"]).machine, null);
	assert.throws(() => parseArgs(["--machine", "node03", "hosted-db"]), /Unknown machine node03 \(node02, node01\)/);
	assert.throws(() => parseArgs(["--machine"]), /--machine needs a value/);
	assert.deepEqual(candidateMachines(null, {}), MACHINES);
	assert.deepEqual(candidateMachines("node01", {}), [MACHINES[1]]);
	assert.deepEqual(candidateMachines(null, { QORPERA_TEST_MACHINE: "me@192.0.2.9" }), [
		{ name: "custom", host: "me@192.0.2.9", jump: "company41-node-02" },
	]);
	assert.deepEqual(candidateMachines(null, { QORPERA_TEST_MACHINE_JUMP: "" }), [
		{ name: "custom", host: "tester@10.201.0.2", jump: "" },
	]);
	assert.throws(() => candidateMachines("node01", { QORPERA_TEST_MACHINE: "me@192.0.2.9" }), /use one/);
	assert.equal(customTarget({}), false);
	assert.equal(customTarget({ QORPERA_TEST_MACHINE: "" }), false);
	assert.equal(customTarget({ QORPERA_TEST_MACHINE_JUMP: "" }), true);
});

test("a run goes to the machine with the most free slots; ties keep list order; silent machines drop out", () => {
	const idle = (name) => ({ name, busy: 0, waiting: 0, quickBusy: 0, quickWaiting: 0, arriving: 0, closed: false, setUp: true, cpus: 10, load: 0.1 });
	const names = (probes, pinned = false, quick = false) => rankMachines(probes, pinned, quick).map((probe) => probe.name);
	assert.deepEqual(names([idle("node02"), idle("node01")]), ["node02", "node01"]);
	assert.deepEqual(names([{ ...idle("node02"), busy: 2 }, { ...idle("node01"), busy: 1 }]), ["node01", "node02"]);
	assert.deepEqual(names([{ ...idle("node02"), busy: 1 }, { ...idle("node01"), busy: 1 }]), ["node02", "node01"]);
	// Both full: the shorter queue.
	assert.deepEqual(names([{ ...idle("node02"), busy: 5, waiting: 4 }, { ...idle("node01"), busy: 5, waiting: 1 }]), [
		"node01",
		"node02",
	]);
	// Waiting runs, and runs still being copied, take the next free slots first.
	assert.deepEqual(names([{ ...idle("node02"), busy: 1, waiting: 2 }, { ...idle("node01"), busy: 2 }]), ["node01", "node02"]);
	assert.deepEqual(names([{ ...idle("node02"), arriving: 2 }, { ...idle("node01"), busy: 1 }]), ["node01", "node02"]);
	// A free slot beats a queue, whatever the load.
	assert.deepEqual(names([{ ...idle("node02"), busy: 5, waiting: 1, load: 0.5 }, { ...idle("node01"), busy: 2, load: 9 }]), [
		"node01",
		"node02",
	]);
	assert.deepEqual(names([idle("node02"), { name: "node01", unreachable: "connect failed: No route to host" }]), ["node02"]);
	assert.deepEqual(names([{ name: "node02", unreachable: "a" }, { name: "node01", unreachable: "b" }]), []);
	// A closed machine takes no automatic runs, however free; a run that names it still goes there.
	assert.deepEqual(names([{ ...idle("node02"), busy: 4, waiting: 5 }, { ...idle("node01"), closed: true }]), ["node02"]);
	assert.deepEqual(names([{ ...idle("node01"), closed: true }], true), ["node01"]);
	assert.deepEqual(names([{ ...idle("node01"), closed: true }]), []);
	// So does a machine whose setup has not finished.
	assert.deepEqual(names([{ ...idle("node02"), busy: 4 }, { ...idle("node01"), setUp: false }]), ["node02"]);
	assert.deepEqual(names([{ ...idle("node01"), setUp: false }], true), ["node01"]);
	assert.equal(
		describeProbes([{ ...idle("node02"), busy: 5, waiting: 2 }, { name: "node01", unreachable: "no answer in 12 s" }]),
		"node02 5/5 slots busy, 2 waiting, quick 0/2; node01 unreachable (no answer in 12 s)",
	);
	assert.equal(
		describeProbes([{ ...idle("node01"), closed: true, busy: 1, arriving: 2, quickBusy: 1, quickWaiting: 2 }]),
		"node01 closed, 1/5 slots busy, 0 waiting, 2 arriving, quick 1/2 + 2 waiting",
	);
	assert.equal(
		describeProbes([{ ...idle("node01"), busy: 4, extraBusy: 2 }]),
		"node01 4/5 slots busy + 2 extra, 0 waiting, quick 0/2",
	);
	assert.equal(describeProbes([{ ...idle("node01"), setUp: false }]), "node01 not set up, 0/5 slots busy, 0 waiting, quick 0/2");
});

test("a quick run goes to the machine with the free quick slot, however full its CPU slots", () => {
	const idle = (name) => ({ name, busy: 0, waiting: 0, quickBusy: 0, quickWaiting: 0, arriving: 0, closed: false, setUp: true, cpus: 10, load: 0.1 });
	const names = (probes, quick) => rankMachines(probes, false, quick).map((probe) => probe.name);
	const probes = [{ ...idle("node02"), quickBusy: 1 }, { ...idle("node01"), busy: 5, waiting: 4, arriving: 1 }];
	assert.deepEqual(names(probes, true), ["node01", "node02"]);
	assert.deepEqual(runOrder(probes, false, true), ["node01", "node02"]);
	// A machine with runs in its extra slots has less room than one without.
	assert.deepEqual(names([{ ...idle("node02"), busy: 4, extraBusy: 1 }, { ...idle("node01"), busy: 4 }], false), ["node01", "node02"]);
	// Any other run ranks by the CPU lane, as before.
	assert.deepEqual(names(probes, false), ["node02", "node01"]);
	assert.deepEqual(runOrder(probes, false, false), ["node02", "node01"]);
	// A quick run waiting in a quick queue counts against it; arriving copies count against the CPU lane only.
	assert.deepEqual(names([{ ...idle("node02"), quickBusy: 1, quickWaiting: 1 }, { ...idle("node01"), quickBusy: 1 }], true), ["node01", "node02"]);
	assert.deepEqual(names([{ ...idle("node02"), arriving: 3 }, idle("node01")], true), ["node02", "node01"]);
	// Closed machines stay out of a quick run's choice too.
	assert.deepEqual(names([{ ...idle("node02"), closed: true }, { ...idle("node01"), quickBusy: 1 }], true), ["node01"]);
});

test("machines that did not answer are tried only when no answering machine is open; closed ones never unless named", () => {
	const idle = (name) => ({ name, busy: 0, waiting: 0, arriving: 0, closed: false, setUp: true, cpus: 10, load: 0.1 });
	const silent = (name) => ({ name, unreachable: "Connection timed out during banner exchange" });
	// An open machine that answered takes the run, even a full one: its failure is then the run's real error.
	assert.deepEqual(runOrder([silent("node02"), { ...idle("node01"), busy: 4, waiting: 2 }], false), ["node01"]);
	assert.deepEqual(runOrder([idle("node02"), idle("node01")], false), ["node02", "node01"]);
	// A slow probe alone does not fail a run: the copy's own connection decides.
	assert.deepEqual(runOrder([silent("node02"), silent("node01")], false), ["node02", "node01"]);
	assert.deepEqual(runOrder([{ ...idle("node02"), closed: true }, silent("node01")], false), ["node01"]);
	assert.deepEqual(runOrder([{ ...idle("node02"), closed: true }], false), []);
	assert.deepEqual(runOrder([{ ...idle("node02"), closed: true }], true), ["node02"]);
	assert.deepEqual(runOrder([{ ...idle("node02"), setUp: false }, silent("node01")], false), ["node01"]);
});

test("probes: a free machine gives the others a short grace; otherwise every probe gets the full time", async () => {
	const machines = [{ name: "node02" }, { name: "node01" }];
	// Answers after `ms`, or never; settles as unreachable when told to stop, as the SSH probe does.
	const asker = (answers) => (machine, signal) =>
		new Promise((resolvePromise) => {
			const answer = answers[machine.name];
			if (answer) setTimeout(() => resolvePromise({ name: machine.name, ...answer.value }), answer.ms);
			signal.addEventListener("abort", () => resolvePromise({ name: machine.name, unreachable: signal.reason.message }));
		});
	const timing = { graceMs: 150, timeoutMs: 1500 };
	const free = { busy: 1, waiting: 0, arriving: 0, closed: false, setUp: true };
	const full = { busy: 4, waiting: 4, arriving: 0, closed: false, setUp: true };

	let started = Date.now();
	let probes = await probeAll(machines, asker({ node02: { ms: 10, value: free } }), timing);
	const graceElapsed = Date.now() - started;
	assert.deepEqual(probes[1], { name: "node01", unreachable: "no answer within 0.15 s of node02's" });
	assert.ok(graceElapsed >= 150 && graceElapsed < 1000, String(graceElapsed));

	started = Date.now();
	probes = await probeAll(machines, asker({ node02: { ms: 10, value: full } }), timing);
	assert.deepEqual(probes[1], { name: "node01", unreachable: "no answer in 1.5 s" });
	assert.ok(Date.now() - started >= 1400);

	// Both answer inside the grace: nothing is cut short.
	probes = await probeAll(machines, asker({ node02: { ms: 10, value: free }, node01: { ms: 40, value: full } }), timing);
	assert.deepEqual(probes.map((probe) => probe.unreachable), [undefined, undefined]);
	// A closed machine's answer starts no grace, nor does one that is not set up.
	probes = await probeAll(machines, asker({ node02: { ms: 10, value: { ...free, closed: true } } }), timing);
	assert.equal(probes[1].unreachable, "no answer in 1.5 s");
	probes = await probeAll(machines, asker({ node02: { ms: 10, value: { ...free, setUp: false } } }), timing);
	assert.equal(probes[1].unreachable, "no answer in 1.5 s");
	// A quick run's grace starts at a free quick slot, whatever the CPU slots.
	probes = await probeAll(machines, asker({ node02: { ms: 10, value: { ...full, quickBusy: 0, quickWaiting: 0 } } }), { ...timing, quick: true });
	assert.equal(probes[1].unreachable, "no answer within 0.15 s of node02's");
	probes = await probeAll(machines, asker({ node02: { ms: 10, value: { ...free, quickBusy: 2, quickWaiting: 0 } } }), { ...timing, quick: true });
	assert.equal(probes[1].unreachable, "no answer in 1.5 s");
	// A front run's grace starts at a slot free ahead of the queue, however long the queue.
	probes = await probeAll(machines, asker({ node02: { ms: 10, value: { ...full, busy: 3, frontWaiting: 0 } } }), { ...timing, front: true });
	assert.equal(probes[1].unreachable, "no answer within 0.15 s of node02's");
	probes = await probeAll(machines, asker({ node02: { ms: 10, value: { ...full, busy: 4, frontWaiting: 1 } } }), { ...timing, front: true });
	assert.equal(probes[1].unreachable, "no answer in 1.5 s");
});

test("a machine that fails before the suite starts passes the run to the next; the last failure stands", async () => {
	const ranked = [{ name: "node01" }, { name: "node02" }];
	const passed = [];
	const passOver = (machine, error, next) => passed.push(`${machine.name}: ${error.message} -> ${next.name}`);
	const tried = [];
	const copy = (failing, final = false) => (machine) => {
		tried.push(machine.name);
		if (failing.includes(machine.name)) throw Object.assign(new Error(`${machine.name} refused`), { final });
	};
	assert.equal(await firstTaking(ranked, copy([]), passOver), ranked[0]);
	assert.deepEqual([tried.splice(0), passed.splice(0)], [["node01"], []]);
	assert.equal(await firstTaking(ranked, copy(["node01"]), passOver), ranked[1]);
	assert.deepEqual([tried.splice(0), passed.splice(0)], [["node01", "node02"], ["node01: node01 refused -> node02"]]);
	// The error names every machine's failure, the first one included.
	await assert.rejects(firstTaking(ranked, copy(["node01", "node02"]), passOver), {
		message: "node02 refused (before: node01: node01 refused)",
	});
	assert.deepEqual([tried.splice(0), passed.splice(0)], [["node01", "node02"], ["node01: node01 refused -> node02"]]);
	await assert.rejects(firstTaking([], copy([]), passOver), /No test machine/);
	// A copy a signal ended is final: the run stops instead of starting a suite on the next machine.
	await assert.rejects(firstTaking(ranked, copy(["node01"], true), passOver), /node01 refused/);
	assert.deepEqual([tried.splice(0), passed.splice(0)], [["node01"], []]);
	// Before moving on, timers and signals get their turn (a pending interrupt exits first).
	let turned = false;
	setTimeout(() => {
		turned = true;
	}, 0);
	await firstTaking(ranked, copy(["node01"]), () => assert.equal(turned, true));
});

test("the probe reads the locks the run script takes and counts runs still being copied", () => {
	const probe = probeScript({ locks: "/run/lock", closed: CLOSED, setUp: SET_UP, arriving: "/home/tester/arriving" });
	assert.equal(CLOSED, "/etc/qorpera-test-machine-closed");
	// guest-setup.sh writes this file last.
	assert.equal(SET_UP, "/etc/qorpera-test-machine-versions");
	assert.match(readFileSync(new URL("../deploy/test-machine/guest-setup.sh", import.meta.url), "utf8"), /\| tee \/etc\/qorpera-test-machine-versions\n$/);
	assert.equal(spawnSync("bash", ["-n", "-c", probe]).status, 0);
	const script = runScript({ run: "R", runDir: "/r", treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true" });
	assert.match(script, /lock="\/run\/lock\/qorpera-test-machine-slot\$candidate\.lock"; \{ exec 9<"\$lock" \|\| exec 9>"\$lock"; \}/);
	assert.match(probe, /5<\/run\/lock\/qorpera-test-machine-slot"\$i\.lock"/);
	// The kept slot, which is counted in busy too, is counted again on its own.
	assert.match(
		probe,
		/kept_busy=0; for i in \$\(seq 5 5\); do \{ flock -n 5 \|\| kept_busy=\$\(\(kept_busy \+ 1\)\); \} 2>\/dev\/null 5<\/run\/lock\/qorpera-test-machine-slot"\$i\.lock"; done/,
	);
	assert.match(probe, / front_waiting=\$front_waiting kept_busy=\$kept_busy extra_busy=\$extra_busy closed=/);
	// guest-setup.sh makes the kept slot's lock file root's and read-only, now and at every boot.
	const setup = readFileSync(new URL("../deploy/test-machine/guest-setup.sh", import.meta.url), "utf8");
	assert.match(setup, /^kept=\/run\/lock\/qorpera-test-machine-slot5\.lock$/m);
	assert.match(setup, /^echo "f \$kept 0644 root root -" >\/etc\/tmpfiles\.d\/qorpera-test-machine\.conf$/m);
	assert.match(setup, /chown root:root "\$kept"; chmod 0644 "\$kept"/);
	assert.match(script, /ticket=\/run\/lock\/qorpera-test-machine-queue\//);
	assert.match(probe, /for t in \/run\/lock\/qorpera-test-machine-queue\/\*; do/);
	assert.match(probe, /for i in \$\(seq 1 5\); do \{ flock -n 5 \|\| busy=\$\(\(busy \+ 1\)\); \}/);
	assert.match(probe, /\[ -e \/etc\/qorpera-test-machine-closed \] && closed=1; \[ -e \/etc\/qorpera-test-machine-versions \] && setup=1/);
	// The quick lane's slots and queue, which a quick run's script takes, are counted apart.
	const quick = runScript({ run: "R", runDir: "/r", treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true", quick: true });
	assert.match(quick, /lock="\/run\/lock\/qorpera-test-machine-quick-slot\$candidate\.lock"; \{ exec 9<"\$lock" \|\| exec 9>"\$lock"; \}/);
	assert.match(probe, /for i in \$\(seq 1 2\); do \{ flock -n 5 \|\| quick_busy=\$\(\(quick_busy \+ 1\)\); \} 2>\/dev\/null 5<\/run\/lock\/qorpera-test-machine-quick-slot"\$i\.lock"; done/);
	assert.match(quick, /ticket=\/run\/lock\/qorpera-test-machine-quick-queue\//);
	assert.match(probe, /for t in \/run\/lock\/qorpera-test-machine-quick-queue\/\*; do \{ flock -n 5 \|\| quick_waiting=\$\(\(quick_waiting \+ 1\)\); \}/);
	assert.match(probe, /echo "busy=\$busy waiting=\$waiting quick_busy=\$quick_busy quick_waiting=\$quick_waiting arriving=/);
	// A front run's ticket, which only a front run's script takes, is counted again on its own.
	const front = runScript({ run: "R", runDir: "/r", treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true", front: true });
	assert.match(front, /ticket=\/run\/lock\/qorpera-test-machine-queue\/0-/);
	assert.match(probe, /for t in \/run\/lock\/qorpera-test-machine-queue\/0-\*; do \{ flock -n 5 \|\| front_waiting=\$\(\(front_waiting \+ 1\)\); \} 2>\/dev\/null 5<"\$t"; done/);
	assert.match(probe, / arriving=\$arriving front_waiting=\$front_waiting /);
	// The copy marker: made by the run's first SSH call, dropped once it holds a queue ticket, pruned by name.
	// Arithmetic expansion drops the padding BSD wc adds.
	assert.match(probe, /arriving=\$\(\( \$\(find \/home\/tester\/arriving -maxdepth 1 -type f -mmin -10 2>\/dev\/null \| wc -l\) \)\)/);
	assert.ok(script.indexOf("flock 7;") < script.indexOf("rm -f /home/tester/arriving/R"));
	assert.ok(script.indexOf("rm -f /home/tester/arriving/R") < script.indexOf("while [ -z \"$slot\" ]"));
	assert.match(pruneScript(), /for f in \/home\/tester\/arriving\/\*; do n=\$\(basename "\$f"\); if \[\[ "\$n" =~ \^\[0-9\]\{8\}T/);
	// Read-only: locks are opened for reading, never created, and tried without waiting.
	assert.doesNotMatch(probe, /\d>"|>>|touch|mkdir|rm /);
	assert.match(probe, /flock -n 5/);
});

const flockNoFork = /--no-fork/.test(spawnSync("flock", ["--help"], { encoding: "utf8" }).stdout ?? "");
test(
	"the probe counts held slots, live queue tickets and fresh copy markers only, and creates no file",
	{ skip: flockNoFork ? false : "no util-linux flock(1) here; the test machines have it" },
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "run-on-node-locks-"));
		const paths = (root) => ({ locks: root, closed: join(root, "closed"), setUp: join(root, "versions"), arriving: join(root, "arriving") });
		const ask = (root) => parseStatus(spawnSync("bash", ["-c", probeScript(paths(root))], { encoding: "utf8" }).stdout);
		const holders = [];
		// --no-fork: the shell that reports the lock is the process that holds it, and killing it frees it.
		const hold = (file) =>
			new Promise((resolvePromise, reject) => {
				const child = spawn("flock", ["--nonblock", "--no-fork", file, "sh", "-c", "echo held; exec sleep 60"], {
					stdio: ["ignore", "pipe", "inherit"],
				});
				holders.push(child);
				child.stdout.once("data", () => resolvePromise());
				child.once("exit", (code) => reject(new Error(`lock holder for ${file} exited ${code}`)));
			});
		try {
			mkdirSync(join(dir, "qorpera-test-machine-queue"));
			mkdirSync(join(dir, "qorpera-test-machine-quick-queue"));
			mkdirSync(join(dir, "arriving"));
			writeFileSync(join(dir, "versions"), "os=test\n");
			await hold(join(dir, "qorpera-test-machine-slot1.lock"));
			writeFileSync(join(dir, "qorpera-test-machine-slot3.lock"), "");
			await hold(join(dir, "qorpera-test-machine-queue", "1-live"));
			writeFileSync(join(dir, "qorpera-test-machine-queue", "2-dead"), "");
			await hold(join(dir, "qorpera-test-machine-quick-slot1.lock"));
			await hold(join(dir, "qorpera-test-machine-quick-queue", "1-live"));
			await hold(join(dir, "qorpera-test-machine-quick-queue", "2-live"));
			writeFileSync(join(dir, "qorpera-test-machine-quick-queue", "3-dead"), "");
			writeFileSync(join(dir, "arriving", "20261003T060000-1-a"), "");
			const stale = join(dir, "arriving", "20261003T050000-2-b");
			writeFileSync(stale, "");
			utimesSync(stale, new Date(Date.now() - 20 * 60_000), new Date(Date.now() - 20 * 60_000));
			const listing = () =>
				[dir, join(dir, "qorpera-test-machine-queue"), join(dir, "qorpera-test-machine-quick-queue"), join(dir, "arriving")].map((d) =>
					readdirSync(d).sort(),
				);
			const before = listing();
			const result = spawnSync("bash", ["-c", probeScript(paths(dir))], { encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stderr, "");
			const answer = parseStatus(result.stdout);
			assert.deepEqual([answer.busy, answer.waiting, answer.arriving, answer.closed, answer.setup], ["1", "1", "1", "0", "1"]);
			assert.deepEqual([answer.quick_busy, answer.quick_waiting], ["1", "2"]);
			assert.deepEqual([answer.front_waiting, answer.kept_busy], ["0", "0"]);
			assert.match(answer.cpus, /^[1-9][0-9]*$/);
			// Slot 2 was never made, and nothing else appeared or went: not the kept slot's file either.
			assert.deepEqual(listing(), before);
			// A run in the kept slot counts as busy and as kept.
			await hold(join(dir, "qorpera-test-machine-slot5.lock"));
			const kept = ask(dir);
			assert.deepEqual([kept.busy, kept.kept_busy], ["2", "1"]);
			// A live front ticket counts as waiting and as front; a dead one as neither.
			await hold(join(dir, "qorpera-test-machine-queue", "0-1760650000000000001-7"));
			writeFileSync(join(dir, "qorpera-test-machine-queue", "0-1760650000000000002-8"), "");
			const front = ask(dir);
			assert.deepEqual([front.waiting, front.front_waiting], ["2", "1"]);
			writeFileSync(join(dir, "closed"), "resize to 12 vCPU\n");
			assert.equal(ask(dir).closed, "1");
			const empty = mkdtempSync(join(tmpdir(), "run-on-node-locks-"));
			try {
				// A machine whose setup has not finished says so.
				const fresh = ask(empty);
				assert.deepEqual([fresh.busy, fresh.waiting, fresh.arriving, fresh.closed, fresh.setup], ["0", "0", "0", "0", "0"]);
				// Set up, and no run has used it yet: no lock files, no queue or copy folder.
				writeFileSync(join(empty, "versions"), "os=test\n");
				const ready = ask(empty);
				assert.deepEqual([ready.busy, ready.waiting, ready.arriving, ready.closed, ready.setup], ["0", "0", "0", "0", "1"]);
				assert.deepEqual([ready.quick_busy, ready.quick_waiting, ready.kept_busy], ["0", "0", "0"]);
				assert.deepEqual(readdirSync(empty), ["versions"]);
			} finally {
				rmSync(empty, { recursive: true, force: true });
			}
		} finally {
			for (const child of holders) child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test(
	"a wide run takes more slots as they free, after earlier front runs and before the rest, and frees them with its session",
	{ skip: flockNoFork ? false : "no util-linux flock(1) here; the test machines have it" },
	async () => {
		const locks = mkdtempSync(join(tmpdir(), "run-on-node-grow-"));
		const queue = join(locks, "qorpera-test-machine-queue");
		const slot = (n) => join(locks, `qorpera-test-machine-slot${n}.lock`);
		const cores = join(locks, "cores");
		const allStarted = join(locks, "all-started");
		// The machine's available memory as grow reads it, replaced whole so it never reads half a file.
		const meminfo = join(locks, "meminfo");
		const memory = (mib) => {
			writeFileSync(`${meminfo}.tmp`, `MemTotal:       16303428 kB\nMemFree:          812344 kB\nMemAvailable:   ${String(mib * 1024).padStart(8)} kB\n`);
			renameSync(`${meminfo}.tmp`, meminfo);
		};
		const holders = new Map();
		const sessions = [];
		const hold = (file) =>
			new Promise((resolvePromise, reject) => {
				const child = spawn("flock", ["--nonblock", "--no-fork", file, "sh", "-c", "echo held; exec sleep 60"], { stdio: ["ignore", "pipe", "inherit"] });
				holders.set(file, child);
				child.stdout.once("data", () => resolvePromise());
				child.once("exit", (code) => reject(new Error(`lock holder for ${file} exited ${code}`)));
			});
		const release = async (file) => {
			const child = holders.get(file);
			holders.delete(file);
			const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
			child.kill("SIGKILL");
			await exited;
		};
		const free = (file) => spawnSync("flock", ["--nonblock", file, "true"]).status === 0;
		const tickets = () => readdirSync(queue).filter((name) => name.endsWith("-more"));
		const until = async (what, check) => {
			for (const end = Date.now() + 15_000; !check(); await sleep(100)) if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
		};
		// A session as runScript leaves it for grow: its first slot locked on fd 9, one slot's cores in the file.
		const session = (want) => {
			const child = spawn(
				"bash",
				[
					"-c",
					[
						"set -uo pipefail",
						`exec 9>${shellQuote(slot(1))}; flock -n 9 || exit 3`,
						`per=2; want=${want}; cores_file=${shellQuote(cores)}; echo "$per" >"$cores_file"`,
						growScript({ locks, allStarted, meminfo }),
						"exec 4> >(grow)",
						"echo started",
						// The session lasts until the test ends its stdin.
						"read -r _",
					].join("\n"),
				],
				{ stdio: ["pipe", "pipe", "inherit"] },
			);
			const state = { out: "", child };
			sessions.push(child);
			child.stdout.on("data", (data) => {
				state.out += data;
			});
			// grow shares the session's stdout, so it ends when grow too has exited.
			state.ended = new Promise((resolvePromise) => child.stdout.once("end", resolvePromise));
			return state;
		};
		try {
			mkdirSync(queue);
			memory(8192);
			for (const n of [2, 3, 4, 5]) await hold(slot(n));
			// An earlier front run and an owner's run wait; a dead ticket sorts first.
			const earlier = join(queue, `${FRONT}1000000000000000000-1`);
			const owner = join(queue, "1760650000000000000-2");
			const dead = join(queue, `${FRONT}0999999999999999999-3`);
			await hold(earlier);
			await hold(owner);
			writeFileSync(dead, "");
			const first = session(3);
			await until("the session", () => first.out.includes("started"));
			await until("grow's own front ticket", () => tickets().length === 1);
			await until("the dead ticket dropped", () => !existsSync(dead));
			// Slot 3 frees, but the earlier front run is ahead.
			await release(slot(3));
			await sleep(3_000);
			assert.doesNotMatch(first.out, /too/);
			assert.equal(readFileSync(cores, "utf8"), "2\n");
			// Once it has gone, grow is first: it takes slot 3, ahead of the owner's run, never its own slot 1.
			await release(earlier);
			await until("slot 3", () => first.out.includes("== run-on-node: slot 3 too: 2 slots, 4 cores\n"));
			assert.equal(readFileSync(cores, "utf8"), "4\n");
			assert.equal(free(slot(3)), false);
			assert.doesNotMatch(first.out, /slot 1 too/);
			assert.equal(tickets().length, 1);
			// The session ends while grow still waits for a third slot: what it took is free, its ticket and the file gone.
			first.child.stdin.end();
			await first.ended;
			assert.deepEqual([free(slot(1)), free(slot(3)), tickets(), existsSync(cores), existsSync(owner)], [true, true, [], false, true]);
			// Two slots free at once: it takes both, the higher first, one a turn, stops waiting, and holds them until its
			// session ends.
			await release(slot(2));
			const second = session(3);
			await until("slots 3 and 2", () => second.out.includes("slot 2 too: 3 slots, 6 cores\n"));
			assert.match(second.out, /== run-on-node: slot 3 too: 2 slots, 4 cores\n== run-on-node: slot 2 too: 3 slots, 6 cores\n/);
			assert.equal(readFileSync(cores, "utf8"), "6\n");
			await until("its ticket gone", () => tickets().length === 0);
			assert.deepEqual([free(slot(2)), free(slot(3))], [false, false]);
			second.child.stdin.end();
			await second.ended;
			assert.deepEqual([free(slot(2)), free(slot(3)), existsSync(cores)], [true, true, false]);
			// Once every step has started it takes no more: a slot that frees then stays free.
			for (const n of [2, 3]) await hold(slot(n));
			const third = session(3);
			await until("grow's own front ticket", () => tickets().length === 1);
			writeFileSync(allStarted, "");
			await until("the stop", () => third.out.includes("== run-on-node: every step has started: no more slots (1 of 3)\n"));
			assert.deepEqual(tickets(), []);
			await release(slot(3));
			await sleep(3_000);
			assert.doesNotMatch(third.out, /too/);
			assert.equal(free(slot(3)), true);
			assert.equal(readFileSync(cores, "utf8"), "2\n");
			third.child.stdin.end();
			await third.ended;
			// Under GROW_MEMORY_MIB available it takes no slot and leaves the queue, so the runs behind it need not wait
			// for it; with enough again it rejoins and takes the free slot.
			assert.equal(GROW_MEMORY_MIB, 2048);
			rmSync(allStarted);
			memory(2047);
			const fourth = session(3);
			await until("the low-memory stop", () => fourth.out.includes("== run-on-node: 2047 MiB available, under 2048: no more slots until there is more\n"));
			assert.deepEqual(tickets(), []);
			await sleep(3_000);
			assert.doesNotMatch(fourth.out, /too/);
			assert.equal(fourth.out.split("under 2048").length, 2);
			assert.deepEqual([free(slot(3)), readFileSync(cores, "utf8"), existsSync(owner)], [true, "2\n", true]);
			memory(2048);
			await until("slot 3", () => fourth.out.includes("== run-on-node: slot 3 too: 2 slots, 4 cores\n"));
			assert.match(fourth.out, /== run-on-node: 2048 MiB available again: waiting for more slots\n== run-on-node: slot 3 too/);
			assert.equal(readFileSync(cores, "utf8"), "4\n");
			// Still one short of three: it waits for one more, with its ticket back.
			assert.equal(tickets().length, 1);
			fourth.child.stdin.end();
			await fourth.ended;
			assert.deepEqual([free(slot(3)), tickets(), existsSync(cores)], [true, [], false]);
			// Two slots free at once, and under GROW_MEMORY_MIB once it has taken the first: it reads the memory again
			// before each slot, so it takes no second.
			await release(slot(2));
			const fifth = session(3);
			await until("slot 3", () => fifth.out.includes("== run-on-node: slot 3 too: 2 slots, 4 cores\n"));
			memory(2047);
			await until("the low-memory stop", () => fifth.out.includes("== run-on-node: 2047 MiB available, under 2048: no more slots until there is more\n"));
			assert.doesNotMatch(fifth.out, /slot 2 too/);
			assert.deepEqual([free(slot(2)), readFileSync(cores, "utf8"), tickets()], [true, "4\n", []]);
			fifth.child.stdin.end();
			await fifth.ended;
			assert.deepEqual([free(slot(2)), free(slot(3)), tickets(), existsSync(cores)], [true, true, [], false]);
		} finally {
			for (const child of [...holders.values(), ...sessions]) child.kill("SIGKILL");
			rmSync(locks, { recursive: true, force: true });
		}
	},
);

test(
	"only a front run takes the kept slot, and first; a slot's lock file is opened for reading, so a read-only one still locks",
	{ skip: flockNoFork ? false : "no util-linux flock(1) here; the test machines have it" },
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "run-on-node-kept-"));
		const slot = (n) => join(dir, `qorpera-test-machine-slot${n}.lock`);
		const holders = new Map();
		const hold = (file) =>
			new Promise((resolvePromise, reject) => {
				const child = spawn("flock", ["--nonblock", "--no-fork", file, "sh", "-c", "echo held; exec sleep 60"], { stdio: ["ignore", "pipe", "inherit"] });
				holders.set(file, child);
				child.stdout.once("data", () => resolvePromise());
				child.once("exit", (code) => reject(new Error(`lock holder for ${file} exited ${code}`)));
			});
		// The lines of a run's script that try the slots, on this directory's lock files: they print the slot taken.
		const tries = (front) => {
			const script = runScript({ run: "R", runDir: "/r", treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true", front });
			const start = script.indexOf("\t\tfor candidate in $(seq");
			const lines = script.slice(start, script.indexOf("\t\tdone\n", start) + "\t\tdone".length).replaceAll("/run/lock/", `${dir}/`);
			assert.match(lines, /flock -n 9; then slot=\$candidate; break; fi/);
			return () => {
				const result = spawnSync("bash", ["-c", `slot=""\n${lines}\necho "$slot"`], { encoding: "utf8" });
				assert.equal(result.status, 0, result.stderr);
				return result.stdout.trim();
			};
		};
		const front = tries(true);
		const normal = tries(false);
		try {
			// The kept slot's file as guest-setup.sh leaves it, not writable by the runs (root's 0644; here 0444).
			writeFileSync(slot(5), "");
			chmodSync(slot(5), 0o444);
			assert.deepEqual([front(), normal(), existsSync(slot(1))], ["5", "1", true]);
			// With the kept slot busy, a front run takes the highest free one, making its file.
			await hold(slot(5));
			assert.deepEqual([front(), existsSync(slot(4))], ["4", true]);
			// Every other slot busy: a run without --front takes none, however free the kept one.
			for (const n of [1, 2, 3, 4]) await hold(slot(n));
			assert.deepEqual([front(), normal()], ["", ""]);
			const kept = holders.get(slot(5));
			const exited = new Promise((resolvePromise) => kept.once("exit", resolvePromise));
			kept.kill("SIGKILL");
			await exited;
			assert.deepEqual([front(), normal()], ["5", ""]);
			// A client from before the change opens a slot's file for writing, which a user other than root cannot here.
			if (process.getuid?.() !== 0) assert.notEqual(spawnSync("bash", ["-c", `exec 9>${shellQuote(slot(5))}`]).status, 0);
		} finally {
			for (const child of holders.values()) child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test("a part's session on each machine says when it is queued and when it holds a slot, and starts only when told", () => {
	const base = { run: "R", runDir: "/home/tester/runs/R", treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true" };
	const claim = runScript({ ...base, claim: true });
	const plain = runScript(base);
	assert.ok(claim.indexOf(`echo "${QUEUED}"`) > claim.indexOf("rm -f /home/tester/arriving/R"));
	assert.ok(claim.indexOf(`echo "${QUEUED}"`) < claim.indexOf('while [ -z "$slot" ]'));
	assert.match(claim, /\t\tread -r -t 2 _; \[ \$\? -gt 128 \] \|\| \{ rm -rf \/home\/tester\/runs\/R; exit 95; \}\n/);
	assert.match(
		claim,
		/rm -f "\$ticket"; exec 7>&-\necho "== run-on-node: holding slot \$slot"\nread -r answer; \[ "\$answer" = go \] \|\| \{ exec 9>&-; rm -rf \/home\/tester\/runs\/R; exit 95; \}\nqueued_s=/,
	);
	assert.equal(DROPPED, 95);
	// Any other run waits as before and says neither.
	assert.match(plain, /\t\tsleep 2\n/);
	assert.ok(!plain.includes(QUEUED) && !plain.includes(SLOT) && !plain.includes("read -r"));
	assert.equal(plain, claim.replace(`echo "${QUEUED}"\n`, "").replace(/\t\tread -r -t 2 .*\n/, "\t\tsleep 2\n").replace(/echo "== run-on-node: holding slot.*\nread -r answer.*\n/, ""));
});

test(
	"a part's session takes a slot only to offer it: it starts on go, and leaves the queue or frees the slot when its input ends",
	{ skip: flockNoFork ? false : "no util-linux flock(1) here; the test machines have it" },
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "run-on-node-claim-"));
		const queue = join(dir, "qorpera-test-machine-queue");
		const slot = (n) => join(dir, `qorpera-test-machine-slot${n}.lock`);
		const runDir = join(dir, "run");
		const holders = new Map();
		const sessions = [];
		const hold = (file) =>
			new Promise((resolvePromise, reject) => {
				const child = spawn("flock", ["--nonblock", "--no-fork", file, "sh", "-c", "echo held; exec sleep 60"], { stdio: ["ignore", "pipe", "inherit"] });
				holders.set(file, child);
				child.stdout.once("data", () => resolvePromise());
				child.once("exit", (code) => reject(new Error(`lock holder for ${file} exited ${code}`)));
			});
		const release = async (file) => {
			const child = holders.get(file);
			holders.delete(file);
			const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
			child.kill("SIGKILL");
			await exited;
		};
		const free = (file) => spawnSync("flock", ["--nonblock", file, "true"]).status === 0;
		const tickets = () => (existsSync(queue) ? readdirSync(queue) : []);
		const until = async (what, check) => {
			for (const end = Date.now() + 15_000; !check(); await sleep(100)) if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
		};
		// The session's lines from its queue to its answer, on this directory's locks; once started, it holds its slot.
		const script = runScript({ run: "R", runDir, treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true", claim: true });
		const lines = script
			.slice(script.indexOf("mkdir -p /run/lock/"), script.indexOf("queued_s="))
			.replaceAll("/run/lock/", `${dir}/`)
			.replaceAll("/home/tester/arriving/", `${dir}/arriving-`)
			// No room for an extra slot, whatever this machine has.
			.replaceAll("/proc/meminfo", `${dir}/no-meminfo`);
		const session = () => {
			mkdirSync(runDir, { recursive: true });
			writeFileSync(join(dir, "arriving-R"), "");
			const child = spawn("bash", ["-c", `set -uo pipefail\n${lines}echo "started in $slot"\nexec sleep 60`], { stdio: ["pipe", "pipe", "inherit"] });
			sessions.push(child);
			const state = { out: "", child };
			child.stdout.on("data", (data) => {
				state.out += data;
			});
			state.ended = new Promise((resolvePromise) => child.once("exit", (code) => resolvePromise(code)));
			return state;
		};
		try {
			// A free slot: queued (the copy no longer counts as arriving), then the slot, then nothing until go.
			const first = session();
			await until("its slot", () => first.out.includes(`${SLOT} 1\n`));
			assert.equal(first.out, `${QUEUED}\n${SLOT} 1\n`);
			assert.deepEqual([existsSync(join(dir, "arriving-R")), tickets(), free(slot(1))], [false, [], false]);
			await sleep(500);
			assert.doesNotMatch(first.out, /started/);
			first.child.stdin.end("go\n");
			await until("the start", () => first.out.includes("started in 1\n"));
			assert.equal(free(slot(1)), false);
			first.child.kill("SIGKILL");
			await first.ended;
			// Its input ends while it holds the slot: it frees the slot, removes its run directory and leaves.
			const second = session();
			await until("its slot", () => second.out.includes(`${SLOT} 1\n`));
			second.child.stdin.end();
			assert.equal(await second.ended, DROPPED);
			assert.deepEqual([free(slot(1)), existsSync(runDir), tickets(), second.out.includes("started")], [true, false, [], false]);
			// Every slot it may take busy: it waits, and offers the first that frees.
			for (const n of [1, 2, 3, 4]) await hold(slot(n));
			const third = session();
			await until("its wait", () => third.out.includes("== run-on-node: waiting for a slot in the CPU lane"));
			assert.ok(third.out.startsWith(`${QUEUED}\n`));
			assert.equal(tickets().length, 1);
			await release(slot(2));
			await until("slot 2", () => third.out.includes(`${SLOT} 2\n`));
			third.child.stdin.end("no\n");
			assert.equal(await third.ended, DROPPED);
			assert.deepEqual([free(slot(2)), existsSync(runDir), tickets()], [true, false, []]);
			// Its input ends while it waits: it leaves the queue within one wait, with its run directory.
			await hold(slot(2));
			const fourth = session();
			await until("its wait", () => fourth.out.includes("== run-on-node: waiting for a slot in the CPU lane"));
			const left = Date.now();
			fourth.child.stdin.end();
			assert.equal(await fourth.ended, DROPPED);
			assert.ok(Date.now() - left < 3_000, `left after ${Date.now() - left} ms`);
			assert.deepEqual([tickets(), existsSync(runDir), fourth.out.includes(SLOT)], [[], false, false]);
		} finally {
			for (const child of [...holders.values(), ...sessions]) child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test("a part starts in the first slot offered on a machine none of its run's other parts uses; elsewhere it waits a little", () => {
	const copy = (machine, state, heldAt) => ({ machine, state, ...(heldAt === undefined ? {} : { heldAt }) });
	// No slot offered yet.
	assert.deepEqual(pickSlot([copy("node02", "waiting"), copy("node01", "queued")], [], 0), {});
	// A slot on a machine no other part runs on is taken at once, whatever else may come.
	const spread = copy("node01", "slot", 100);
	assert.equal(pickSlot([copy("node02", "starting"), spread], ["node02"], 100).take, spread);
	assert.equal(pickSlot([copy("node02", "slot", 50), spread], ["node02"], 100).take, spread);
	// On a machine another part uses, while its session elsewhere may still offer one: it waits SPREAD_MS at most.
	const busy = copy("node02", "slot", 1_000);
	for (const state of ["gated", "starting", "queued"])
		assert.deepEqual(pickSlot([busy, copy("node01", state)], ["node02"], 4_000), { wait: SPREAD_MS - 3_000 }, state);
	assert.equal(pickSlot([busy, copy("node01", "queued")], ["node02"], 1_000 + SPREAD_MS).take, busy);
	// Taken at once when no session elsewhere may offer one soon: it waits for a slot there, ended, or left.
	for (const state of ["waiting", "ended", "dropped", "skipped"]) assert.equal(pickSlot([busy, copy("node01", state)], ["node02"], 1_000).take, busy, state);
	assert.equal(pickSlot([busy], ["node02"], 1_000).take, busy);
	// Two slots on busy machines: the one offered first.
	const earlier = copy("node01", "slot", 500);
	assert.equal(pickSlot([busy, earlier], ["node01", "node02"], 1_000).take, earlier);
	assert.equal(SPREAD_MS, 15_000);
});

test("the status file reads back runner, install and times", () => {
	assert.deepEqual(parseStatus("runner=ci03\ninstalled=1 prepare_ms=1200\nsuite_ms=900\n"), {
		runner: "ci03",
		installed: "1",
		prepare_ms: "1200",
		suite_ms: "900",
	});
	assert.deepEqual(parseStatus("runner=ci03\ninstalled=0\n"), { runner: "ci03", installed: "0" });
	assert.deepEqual(parseStatus(""), {});
});

test("the --record file is written whole: a new file renamed over the old one, never rewritten in place, no temp left", () => {
	const dir = mkdtempSync(join(tmpdir(), "run-on-node-record-"));
	try {
		const record = join(dir, "record.json");
		writeWhole(record, "first\n");
		assert.equal(readFileSync(record, "utf8"), "first\n");
		// A reader holding the old file keeps it whole: the new record is another file, renamed over the path.
		const old = join(dir, "old.json");
		linkSync(record, old);
		writeWhole(record, "second\n");
		assert.equal(readFileSync(record, "utf8"), "second\n");
		assert.equal(readFileSync(old, "utf8"), "first\n");
		assert.deepEqual(readdirSync(dir).sort(), ["old.json", "record.json"]);
		// A write that cannot land throws and leaves no temp file: here the path is a folder.
		const folder = join(dir, "folder");
		mkdirSync(folder);
		assert.throws(() => writeWhole(folder, "third\n"));
		assert.deepEqual(readdirSync(dir).sort(), ["folder", "old.json", "record.json"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("shell quoting survives a round trip through bash", () => {
	for (const value of ["plain", "a b", "it's", "$HOME", "`x`", 'q"uote', "*", ""]) {
		const result = spawnSync("bash", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" });
		assert.equal(result.stdout, value);
	}
});

test("include rules are anchored and refuse wildcard names", () => {
	assert.deepEqual(includeRules(["a/b.txt", ".github/x.yml"]), ["+ /a/b.txt", "+ /.github/x.yml"]);
	assert.throws(() => includeRules(["routes/[id].ts"]), /wildcard/);
	assert.throws(() => includeRules(["a\nb"]), /wildcard/);
});

test("untracked files that look like secrets are named", () => {
	assert.deepEqual(
		secretLooking([
			".env.local",
			"apps/x/.env",
			"certs/server.pem",
			"deploy/id_ed25519",
			"passwords.private.json",
			".npmrc",
			".envrc",
			"home/.aws/credentials",
			"infra/prod.tfvars",
			"config/staging.env",
			"src/cloud-secret-broker.ts",
			"src/id_utils.ts",
			"scripts/new-test.mjs",
		]),
		[
			".env.local",
			"apps/x/.env",
			"certs/server.pem",
			"deploy/id_ed25519",
			"passwords.private.json",
			".npmrc",
			".envrc",
			"home/.aws/credentials",
			"infra/prod.tfvars",
			"config/staging.env",
		],
	);
});

test("cleanup prunes runs by the UTC time in their name, never by mtime", () => {
	const script = pruneScript();
	assert.match(script, /date -u -d '-1 day' \+%Y%m%dT%H%M%S/);
	assert.match(script, /\$\{n%%-\*\}" < "\$cutoff"/);
	assert.doesNotMatch(script, /-mmin|-mtime \+1\b/);
	assert.match(script, /sudo -n rm -rf/);
	assert.equal(spawnSync("bash", ["-n", "-c", script]).status, 0);
});

test("cleanup removes worktree copies unused for 3 days, only when no run holds their lock", () => {
	const script = pruneScript();
	assert.match(script, /find \/home\/tester\/trees -maxdepth 1 -name '\*\.lock' -mtime \+2 /);
	assert.match(script, /flock -n "\$l" sudo -n rm -rf -- "\$\{l%\.lock\}"/);
});

function files(root) {
	const out = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else out.push(relative(root, path));
		}
	};
	walk(root);
	return out.sort();
}

test("a shared base copy compares contents: another checkout's same-size, same-mtime file is never reused", () => {
	const temporary = mkdtempSync(join(tmpdir(), "run-on-node-test-"));
	try {
		const when = new Date("2026-10-14T21:00:00Z");
		const checkout = (name, bytes) => {
			mkdirSync(join(temporary, name));
			writeFileSync(join(temporary, name, "f.ts"), bytes);
			utimesSync(join(temporary, name, "f.ts"), when, when);
			return join(temporary, name);
		};
		const first = checkout("first", "aaaa\n");
		const second = checkout("second", "bbbb\n");
		const treeDir = join(temporary, "tree");
		const refresh = (runDir, shared) => {
			const line = runScript({ run: "R", runDir, treeDir, shared, files: 1, copySeconds: 0, install: false, build: false, runCommand: "true" })
				.split("\n")
				.find((l) => l.includes("base copy refresh"));
			const result = spawnSync("bash", ["-c", line]);
			assert.equal(result.status, 0, result.stderr?.toString());
		};
		// As copyTree does, without the remote side's locks.
		const upload = (root, runDir) => {
			const options = copyOptions({ treeDir }).filter((option) => !option.startsWith("--rsync-path="));
			const rsync = spawnSync("rsync", ["-a", ...options, `${root}/`, `${runDir}/`]);
			assert.equal(rsync.status, 0, rsync.stderr?.toString());
		};
		mkdirSync(treeDir);
		refresh(first, true);
		assert.equal(readFileSync(join(treeDir, "f.ts"), "utf8"), "aaaa\n");

		upload(second, join(temporary, "run"));
		assert.equal(readFileSync(join(temporary, "run/f.ts"), "utf8"), "bbbb\n");
		refresh(join(temporary, "run"), true);
		assert.equal(readFileSync(join(treeDir, "f.ts"), "utf8"), "bbbb\n");

		// Why: rsync's quick check alone takes the base copy's bytes for the other checkout's file.
		const quick = spawnSync("rsync", ["-a", `--copy-dest=${treeDir}/`, `${first}/`, `${join(temporary, "quick")}/`]);
		assert.equal(quick.status, 0, quick.stderr?.toString());
		assert.equal(readFileSync(join(temporary, "quick/f.ts"), "utf8"), "bbbb\n");
		// Every copy compares contents, so it has the checkout's own bytes. Only the refresh of a checkout's own base copy
		// on the machine keeps the quick check: it holds only that checkout's earlier files.
		upload(first, join(temporary, "copied"));
		assert.equal(readFileSync(join(temporary, "copied/f.ts"), "utf8"), "aaaa\n");
		assert.deepEqual(baseCopyCompare(false), []);
		assert.doesNotMatch(runScript({ run: "R", runDir: "/r", treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true" }), /--checksum/);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a first copy takes what it can from the base copy of the checkout that ran last, and only equal files", () => {
	const temporary = mkdtempSync(join(tmpdir(), "run-on-node-test-"));
	try {
		const trees = join(temporary, "trees");
		mkdirSync(trees);
		const seedOf = (treeDir) => {
			const result = spawnSync("bash", ["-c", seedScript(treeDir, trees)], { encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			return parseSeed(result.stdout);
		};
		const own = join(trees, "own");
		// No other base copy yet, and one that was never refreshed does not count.
		assert.equal(seedOf(own), null);
		const tree = (name, age) => {
			mkdirSync(join(trees, name));
			const lock = join(trees, `${name}.lock`);
			writeFileSync(lock, "");
			const when = new Date(Date.now() - age * 1000);
			utimesSync(lock, when, when);
			return join(trees, name);
		};
		const empty = tree("empty", 0);
		assert.equal(seedOf(own), null);
		// The newest by its lock file, never the checkout's own.
		const old = tree("old", 100);
		writeFileSync(join(old, "package.json"), "{}\n");
		const recent = tree("recent", 50);
		writeFileSync(join(recent, "package.json"), "{}\n");
		assert.equal(seedOf(own), recent);
		assert.equal(seedOf(recent), old);
		assert.equal(seedOf(empty), recent);
		assert.equal(parseSeed(`noise\nseed=${recent}\n`), recent);
		// Only a plain path reaches rsync's remote command line.
		assert.equal(parseSeed("seed=/home/x; rm -rf /\n"), null);

		// Looked for in the run's other parts, then its own base copy, then the seed. Every base copy is read under a shared lock.
		assert.deepEqual(copyOptions({ nearby: ["/runs/p1"], treeDir: "/t/own", seed: "/t/recent" }), [
			"--checksum",
			"--copy-dest=/runs/p1/",
			"--copy-dest=/t/own/",
			"--copy-dest=/t/recent/",
			"--rsync-path=flock -s /t/own.lock flock -s /t/recent.lock rsync",
		]);
		assert.deepEqual(copyOptions({ treeDir: "/t/own" }), ["--checksum", "--copy-dest=/t/own/", "--rsync-path=flock -s /t/own.lock rsync"]);

		// A real copy: an equal file comes from the seed, whatever its time; a same-size, same-time file with other bytes
		// does not; a file the seed lacks is sent.
		const source = join(temporary, "source");
		mkdirSync(source);
		const when = new Date("2026-10-14T21:00:00Z");
		writeFileSync(join(source, "equal.ts"), "same\n");
		writeFileSync(join(source, "other.ts"), "mine\n");
		writeFileSync(join(source, "new.ts"), "new\n");
		utimesSync(join(source, "other.ts"), when, when);
		writeFileSync(join(recent, "equal.ts"), "same\n");
		writeFileSync(join(recent, "other.ts"), "them\n");
		utimesSync(join(recent, "other.ts"), when, when);
		const run = join(temporary, "run");
		const options = copyOptions({ treeDir: own, seed: recent }).filter((option) => !option.startsWith("--rsync-path="));
		const rsync = spawnSync("rsync", ["-a", "--stats", ...options, `${source}/`, `${run}/`], { encoding: "utf8" });
		assert.equal(rsync.status, 0, rsync.stderr);
		assert.equal(readFileSync(join(run, "equal.ts"), "utf8"), "same\n");
		assert.equal(readFileSync(join(run, "other.ts"), "utf8"), "mine\n");
		assert.equal(readFileSync(join(run, "new.ts"), "utf8"), "new\n");
		// Two of the three files were sent: the equal one was copied on the machine.
		assert.match(rsync.stdout, /Number of regular files transferred: 2\b/);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("the copied tree is exactly what git sees, and the digest covers untracked contents", () => {
	const temporary = mkdtempSync(join(tmpdir(), "run-on-node-test-"));
	try {
		const repo = join(temporary, "repo");
		const git = (...args) => assert.equal(spawnSync("git", args, { cwd: repo }).status, 0, args.join(" "));
		mkdirSync(join(repo, "src/deep"), { recursive: true });
		mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });
		git("init", "-q");
		writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.log\n");
		writeFileSync(join(repo, "src/deep/tracked.ts"), "one\n");
		writeFileSync(join(repo, "src/deleted.ts"), "gone soon\n");
		writeFileSync(join(repo, "node_modules/pkg/index.js"), "ignored\n");
		git("add", ".");
		git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "base");
		writeFileSync(join(repo, "src/deep/tracked.ts"), "two\n");
		writeFileSync(join(repo, "src/new-untracked.ts"), "new\n");
		writeFileSync(join(repo, "debug.log"), "ignored\n");
		rmSync(join(repo, "src/deleted.ts"));
		symlinkSync("deep/tracked.ts", join(repo, "src/link.ts"));

		const listed = workingTreeFiles(repo);
		assert.deepEqual(listed.files, [".gitignore", "src/deep/tracked.ts", "src/link.ts", "src/new-untracked.ts"]);
		assert.deepEqual(listed.untracked.sort(), ["src/link.ts", "src/new-untracked.ts"]);

		const before = treeDigest(repo, listed.files);
		writeFileSync(join(repo, "src/new-untracked.ts"), "changed\n");
		assert.notEqual(treeDigest(repo, listed.files), before);

		const rules = join(temporary, "rules");
		writeFileSync(rules, `${includeRules(listed.files).join("\n")}\n+ */\n- *\n`);
		const destination = join(temporary, "copy");
		const rsync = spawnSync("rsync", ["-a", "--prune-empty-dirs", `--filter=merge ${rules}`, `${repo}/`, `${destination}/`]);
		assert.equal(rsync.status, 0, rsync.stderr?.toString());
		assert.deepEqual(files(destination), listed.files);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
