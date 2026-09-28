import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
	includeRules,
	parseArgs,
	pruneScript,
	secretLooking,
	shellQuote,
	suiteCommand,
	treeDigest,
	workingTreeFiles,
} from "./run-on-node.mjs";

test("suites map to their commands", () => {
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
