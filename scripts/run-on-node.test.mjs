import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
	CPU_SLOTS,
	includeRules,
	parseArgs,
	parseStatus,
	pruneScript,
	RUNNERS,
	runScript,
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
	assert.match(script, /ticket=\/run\/lock\/qorpera-test-machine-queue\/\$\(date \+%s%N\)-\$\$; exec 7>"\$ticket"; flock -n 7;/);
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
	for (const [cpus, workers] of [[6, 2], [12, 4], [2, 1]])
		assert.equal(spawnSync("bash", ["-c", `echo $(( ${cpus} / 3 > 0 ? ${cpus} / 3 : 1 ))`], { encoding: "utf8" }).stdout.trim(), String(workers));
	assert.match(parseArgs(["--sudo", "--", "npm", "test"]).command.join(" "), /npm test/);
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
