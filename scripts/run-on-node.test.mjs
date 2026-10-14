import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
	baseCopyCompare,
	CLOSED,
	CPU_SLOTS,
	candidateMachines,
	customTarget,
	describeProbes,
	firstTaking,
	includeRules,
	MACHINES,
	parseArgs,
	parseStatus,
	probeAll,
	probeScript,
	pruneScript,
	RUNNERS,
	rankMachines,
	runOrder,
	runScript,
	SET_UP,
	secretLooking,
	shellQuote,
	suiteCommand,
	treeDigest,
	workingTreeFiles,
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

test("at most three runs execute at once, in arrival order, with two vitest workers each", () => {
	assert.equal(CPU_SLOTS, 3);
	const script = runScript({ run: "R", runDir: "/r", treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true" });
	// The queue ticket sorts by arrival and stays locked by its waiting run (fd 7); only the first ticket
	// may take a slot; a ticket nobody holds belongs to a dead run and is dropped, whatever its pid became.
	assert.match(script, /ticket=\/run\/lock\/qorpera-test-machine-queue\/\$\(date \+%s%N\)-\$\$; exec 7>"\$ticket"; flock 7;/);
	assert.match(script, /if \[ "\$position" = 1 \]; then/);
	assert.match(script, /flock -n "\$t" true 2>\/dev\/null && rm -f "\$t"/);
	assert.doesNotMatch(script, /kill -0/);
	// A lock file that cannot be opened skips that candidate instead of reusing the previous descriptor.
	assert.match(script, /\{ exec 9>"\/run\/lock\/qorpera-test-machine-slot\$candidate\.lock"; \} 2>\/dev\/null \|\| continue/);
	assert.match(script, /\{ exec 8>"\/run\/lock\/qorpera-test-machine-\$candidate\.lock"; \} 2>\/dev\/null \|\| continue/);
	// A killed run's leftovers under the runner user are ended once its lock is held.
	assert.match(script, /sudo -n pkill -KILL -u "\$runner"/);
	assert.match(script, /for candidate in \$\(seq 1 3\); do/);
	assert.match(script, /waiting for a slot \(3 runs at a time\), queue position \$position/);
	// The slot is taken before the runner user, and both stay locked for the session (fds 9 and 8).
	assert.ok(script.indexOf("qorpera-test-machine-slot") < script.indexOf("qorpera-test-machine-$candidate"));
	// vCPUs / 3 workers per run (2 on 6 vCPUs, 4 on 12), at least 1.
	assert.match(script, /export VITEST_MAX_WORKERS=\$\(\( \$\(nproc\) \/ 3 > 0 \? \$\(nproc\) \/ 3 : 1 \)\)/);
	for (const [cpus, workers] of [[6, 2], [10, 3], [12, 4], [2, 1]])
		assert.equal(spawnSync("bash", ["-c", `echo $(( ${cpus} / 3 > 0 ? ${cpus} / 3 : 1 ))`], { encoding: "utf8" }).stdout.trim(), String(workers));
	assert.match(parseArgs(["--sudo", "--", "npm", "test"]).command.join(" "), /npm test/);
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
	const idle = (name) => ({ name, busy: 0, waiting: 0, arriving: 0, closed: false, setUp: true, cpus: 10, load: 0.1 });
	const names = (probes, pinned = false) => rankMachines(probes, pinned).map((probe) => probe.name);
	assert.deepEqual(names([idle("node02"), idle("node01")]), ["node02", "node01"]);
	assert.deepEqual(names([{ ...idle("node02"), busy: 2 }, { ...idle("node01"), busy: 1 }]), ["node01", "node02"]);
	assert.deepEqual(names([{ ...idle("node02"), busy: 1 }, { ...idle("node01"), busy: 1 }]), ["node02", "node01"]);
	// Both full: the shorter queue.
	assert.deepEqual(names([{ ...idle("node02"), busy: 3, waiting: 4 }, { ...idle("node01"), busy: 3, waiting: 1 }]), [
		"node01",
		"node02",
	]);
	// Waiting runs, and runs still being copied, take the next free slots first.
	assert.deepEqual(names([{ ...idle("node02"), busy: 1, waiting: 2 }, { ...idle("node01"), busy: 2 }]), ["node01", "node02"]);
	assert.deepEqual(names([{ ...idle("node02"), arriving: 2 }, { ...idle("node01"), busy: 1 }]), ["node01", "node02"]);
	// A free slot beats a queue, whatever the load.
	assert.deepEqual(names([{ ...idle("node02"), busy: 3, waiting: 1, load: 0.5 }, { ...idle("node01"), busy: 2, load: 9 }]), [
		"node01",
		"node02",
	]);
	assert.deepEqual(names([idle("node02"), { name: "node01", unreachable: "connect failed: No route to host" }]), ["node02"]);
	assert.deepEqual(names([{ name: "node02", unreachable: "a" }, { name: "node01", unreachable: "b" }]), []);
	// A closed machine takes no automatic runs, however free; a run that names it still goes there.
	assert.deepEqual(names([{ ...idle("node02"), busy: 3, waiting: 5 }, { ...idle("node01"), closed: true }]), ["node02"]);
	assert.deepEqual(names([{ ...idle("node01"), closed: true }], true), ["node01"]);
	assert.deepEqual(names([{ ...idle("node01"), closed: true }]), []);
	// So does a machine whose setup has not finished.
	assert.deepEqual(names([{ ...idle("node02"), busy: 3 }, { ...idle("node01"), setUp: false }]), ["node02"]);
	assert.deepEqual(names([{ ...idle("node01"), setUp: false }], true), ["node01"]);
	assert.equal(
		describeProbes([{ ...idle("node02"), busy: 3, waiting: 2 }, { name: "node01", unreachable: "no answer in 12 s" }]),
		"node02 3/3 slots busy, 2 waiting; node01 unreachable (no answer in 12 s)",
	);
	assert.equal(
		describeProbes([{ ...idle("node01"), closed: true, busy: 1, arriving: 2 }]),
		"node01 closed, 1/3 slots busy, 0 waiting, 2 arriving",
	);
	assert.equal(describeProbes([{ ...idle("node01"), setUp: false }]), "node01 not set up, 0/3 slots busy, 0 waiting");
});

test("machines that did not answer are tried only when no answering machine is open; closed ones never unless named", () => {
	const idle = (name) => ({ name, busy: 0, waiting: 0, arriving: 0, closed: false, setUp: true, cpus: 10, load: 0.1 });
	const silent = (name) => ({ name, unreachable: "Connection timed out during banner exchange" });
	// An open machine that answered takes the run, even a full one: its failure is then the run's real error.
	assert.deepEqual(runOrder([silent("node02"), { ...idle("node01"), busy: 3, waiting: 2 }], false), ["node01"]);
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
	const full = { busy: 3, waiting: 4, arriving: 0, closed: false, setUp: true };

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
	assert.match(script, /exec 9>"\/run\/lock\/qorpera-test-machine-slot\$candidate\.lock"/);
	assert.match(probe, /5<\/run\/lock\/qorpera-test-machine-slot"\$i\.lock"/);
	assert.match(script, /ticket=\/run\/lock\/qorpera-test-machine-queue\//);
	assert.match(probe, /for t in \/run\/lock\/qorpera-test-machine-queue\/\*; do/);
	assert.match(probe, /for i in \$\(seq 1 3\); do/);
	assert.match(probe, /\[ -e \/etc\/qorpera-test-machine-closed \] && closed=1; \[ -e \/etc\/qorpera-test-machine-versions \] && setup=1/);
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
			mkdirSync(join(dir, "arriving"));
			writeFileSync(join(dir, "versions"), "os=test\n");
			await hold(join(dir, "qorpera-test-machine-slot1.lock"));
			writeFileSync(join(dir, "qorpera-test-machine-slot3.lock"), "");
			await hold(join(dir, "qorpera-test-machine-queue", "1-live"));
			writeFileSync(join(dir, "qorpera-test-machine-queue", "2-dead"), "");
			writeFileSync(join(dir, "arriving", "20261003T060000-1-a"), "");
			const stale = join(dir, "arriving", "20261003T050000-2-b");
			writeFileSync(stale, "");
			utimesSync(stale, new Date(Date.now() - 20 * 60_000), new Date(Date.now() - 20 * 60_000));
			const listing = () => [dir, join(dir, "qorpera-test-machine-queue"), join(dir, "arriving")].map((d) => readdirSync(d).sort());
			const before = listing();
			const result = spawnSync("bash", ["-c", probeScript(paths(dir))], { encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stderr, "");
			const answer = parseStatus(result.stdout);
			assert.deepEqual([answer.busy, answer.waiting, answer.arriving, answer.closed, answer.setup], ["1", "1", "1", "0", "1"]);
			assert.match(answer.cpus, /^[1-9][0-9]*$/);
			// Slot 2 was never made, and nothing else appeared or went.
			assert.deepEqual(listing(), before);
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
		const upload = (root, runDir, shared) => {
			const rsync = spawnSync("rsync", ["-a", ...baseCopyCompare(shared), `--copy-dest=${treeDir}/`, `${root}/`, `${runDir}/`]);
			assert.equal(rsync.status, 0, rsync.stderr?.toString());
		};
		mkdirSync(treeDir);
		refresh(first, true);
		assert.equal(readFileSync(join(treeDir, "f.ts"), "utf8"), "aaaa\n");

		upload(second, join(temporary, "run"), true);
		assert.equal(readFileSync(join(temporary, "run/f.ts"), "utf8"), "bbbb\n");
		refresh(join(temporary, "run"), true);
		assert.equal(readFileSync(join(treeDir, "f.ts"), "utf8"), "bbbb\n");

		// Why: rsync's quick check alone takes the base copy's bytes for the other checkout's file. A checkout's own
		// base copy keeps the quick check.
		upload(first, join(temporary, "quick"), false);
		assert.equal(readFileSync(join(temporary, "quick/f.ts"), "utf8"), "bbbb\n");
		assert.deepEqual(baseCopyCompare(false), []);
		assert.doesNotMatch(runScript({ run: "R", runDir: "/r", treeDir: "/t", files: 1, copySeconds: 0, install: false, build: false, runCommand: "true" }), /--checksum/);
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
