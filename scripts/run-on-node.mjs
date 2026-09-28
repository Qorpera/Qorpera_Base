import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Runs one test suite on the operator test machine on node 2 instead of Docker on a
 * developer Mac (contract 24.1). The working tree git would see (tracked plus untracked,
 * not ignored, uncommitted changes included) is copied to a fresh per-run directory;
 * only changed files cross the network. Output streams back and the exit code is the
 * suite's. A record of host, versions and elapsed time is printed at the end (24.4). */

const USAGE = `Usage: node scripts/run-on-node.mjs [options] <suite> [-- args]
       node scripts/run-on-node.mjs [options] -- <command...>

Suites: hosted-db            npm run test:hosted-db (no npm ci needed)
        npm:<script>         npm run <script>
        scripts/<file>.mjs   node scripts/<file>.mjs

Options: --install / --no-install   run npm ci --ignore-scripts first (default: yes, except hosted-db)
         --env NAME=VALUE           pass an environment variable (repeatable)
         --sudo                     run the command as root inside the test machine
         --keep                     keep the run directory on the test machine
         --record FILE              also write the run record as JSON to FILE
         --dry-run                  print what would run, change nothing

Target (environment): QORPERA_TEST_MACHINE      default tester@10.201.0.2
                      QORPERA_TEST_MACHINE_JUMP default company41-node-02
                      QORPERA_TEST_MACHINE_KEY  default ~/.ssh/id_ed25519_qorpera_testvm`;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseArgs(argv) {
	const options = { install: undefined, env: [], sudo: false, keep: false, record: null, dryRun: false };
	let i = 0;
	for (; i < argv.length && argv[i] !== "--" && argv[i].startsWith("--"); i++) {
		const flag = argv[i];
		if (flag === "--install") options.install = true;
		else if (flag === "--no-install") options.install = false;
		else if (flag === "--sudo") options.sudo = true;
		else if (flag === "--keep") options.keep = true;
		else if (flag === "--dry-run") options.dryRun = true;
		else if (flag === "--env" || flag === "--record") {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			if (flag === "--record") options.record = value;
			else {
				const equals = value.indexOf("=");
				if (equals < 1 || !NAME.test(value.slice(0, equals))) throw new Error(`Invalid --env ${value}`);
				options.env.push([value.slice(0, equals), value.slice(equals + 1)]);
			}
		} else throw new Error(`Unknown option ${flag}\n\n${USAGE}`);
	}
	const rest = argv.slice(i);
	let suite = null;
	let command;
	if (rest[0] === "--") {
		command = rest.slice(1);
		if (command.length === 0) throw new Error(USAGE);
	} else {
		suite = rest[0];
		if (!suite) throw new Error(USAGE);
		const extra = rest[1] === "--" ? rest.slice(2) : rest.slice(1);
		if (rest[1] !== undefined && rest[1] !== "--") throw new Error(`Put suite arguments after --\n\n${USAGE}`);
		command = [...suiteCommand(suite), ...extra];
	}
	return { ...options, install: options.install ?? suite !== "hosted-db", suite, command };
}

export function suiteCommand(suite) {
	if (suite === "hosted-db") return ["npm", "run", "test:hosted-db"];
	if (suite.startsWith("npm:") && /^npm:[A-Za-z0-9:_.-]+$/.test(suite)) return ["npm", "run", suite.slice(4)];
	if (/^scripts\/[A-Za-z0-9_.-]+\.mjs$/.test(suite)) return ["node", suite];
	throw new Error(`Unknown suite ${suite}\n\n${USAGE}`);
}

export function shellQuote(value) {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/** rsync include rules for exactly these files (anchored); every directory is traversed
 * and everything else is excluded. macOS openrsync has no pattern escapes, so a name
 * with a wildcard character or a line break is refused rather than guessed. */
export function includeRules(files) {
	const unsafe = files.filter((file) => /[[\]*?\\\n\r]/.test(file));
	if (unsafe.length) throw new Error(`Cannot copy file names with wildcard characters: ${unsafe.slice(0, 5).join(", ")}`);
	return files.map((file) => `+ /${file}`);
}

function git(root, args) {
	const result = spawnSync("git", args, { cwd: root, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
	return result.stdout;
}

/** Tracked and untracked-but-not-ignored files that exist now; a deleted tracked file is left out. */
export function workingTreeFiles(root) {
	const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"])
		.toString("utf8")
		.split("\0")
		.filter(Boolean);
	return listed.filter((file) => {
		try {
			const stat = lstatSync(join(root, file));
			return stat.isFile() || stat.isSymbolicLink();
		} catch {
			return false;
		}
	});
}

function sourceIdentity(root) {
	const head = git(root, ["rev-parse", "HEAD"]).toString().trim();
	const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	const diff = git(root, ["diff", "HEAD", "--binary"]);
	return {
		head,
		dirty: status.length > 0,
		changedPaths: status.toString("utf8").split("\0").filter(Boolean).length,
		diffSha256: status.length ? createHash("sha256").update(diff).update(status).digest("hex") : null,
	};
}

function target() {
	const host = process.env.QORPERA_TEST_MACHINE || "tester@10.201.0.2";
	const jump = process.env.QORPERA_TEST_MACHINE_JUMP ?? "company41-node-02";
	const key = process.env.QORPERA_TEST_MACHINE_KEY || join(homedir(), ".ssh", "id_ed25519_qorpera_testvm");
	const ssh = [
		"-o",
		"BatchMode=yes",
		"-o",
		"IdentitiesOnly=yes",
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		`UserKnownHostsFile=${join(homedir(), ".ssh", "known_hosts_qorpera_test_machines")}`,
		"-o",
		"ServerAliveInterval=30",
		"-i",
		key,
		...(jump ? ["-J", jump] : []),
	];
	return { host, jump, ssh, key };
}

function sshRun(t, remoteScript, stdio = "inherit") {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("ssh", [...t.ssh, t.host, "bash", "-c", shellQuote(remoteScript)], { stdio });
		child.on("error", reject);
		child.on("close", (code, signal) => resolvePromise(signal ? 128 : (code ?? 1)));
	});
}

function sshCapture(t, remoteScript) {
	const result = spawnSync("ssh", [...t.ssh, t.host, "bash", "-c", shellQuote(remoteScript)], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Test machine unreachable or refused: ${(result.stderr || "").trim()}`);
	return result.stdout;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).toString().trim();
	const t = target();
	const source = sourceIdentity(root);
	const tree = createHash("sha256").update(`${hostname()}:${root}`).digest("hex").slice(0, 16);
	const run = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-${process.pid}-${randomBytes(4).toString("hex")}`;
	const home = "/home/tester";
	const runDir = `${home}/runs/${run}`;
	const treeDir = `${home}/trees/${tree}`;
	const env = options.env.map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
	const command = options.command.map(shellQuote).join(" ");
	const runCommand = options.sudo ? `sudo -n env ${env} PATH="$PATH" ${command}` : `${env ? `env ${env} ` : ""}${command}`;
	const files = workingTreeFiles(root);
	if (options.dryRun) {
		console.log(JSON.stringify({ target: t.host, runDir, treeDir, files: files.length, install: options.install, runCommand, source }, null, 2));
		return 0;
	}
	if (!existsSync(t.key)) throw new Error(`Missing test machine key ${t.key}`);

	const started = Date.now();
	sshCapture(t, `set -eu; mkdir -p ${runDir} ${treeDir}; find ${home}/runs -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec rm -rf {} +`);
	const rulesDir = mkdtempSync(join(tmpdir(), "run-on-node-"));
	const rules = join(rulesDir, "rules");
	writeFileSync(rules, `${includeRules(files).join("\n")}\n+ */\n- *\n`);
	const rsync = spawnSync(
		"rsync",
		[
			"-a",
			"--prune-empty-dirs",
			`--filter=merge ${rules}`,
			`--copy-dest=${treeDir}/`,
			"-e",
			["ssh", ...t.ssh].map(shellQuote).join(" "),
			`${root}/`,
			`${t.host}:${runDir}/`,
		],
		{ stdio: ["ignore", "inherit", "inherit"] },
	);
	rmSync(rulesDir, { recursive: true, force: true });
	if (rsync.status !== 0) throw new Error(`Copying the working tree failed (rsync exit ${rsync.status})`);
	const synced = Date.now();

	const script = [
		"set -o pipefail",
		`flock ${treeDir}.lock rsync -a --delete ${runDir}/ ${treeDir}/`,
		`cd ${runDir}`,
		`echo "== run-on-node: $(hostname) ${run} (${files.length} files, sync ${((synced - started) / 1000).toFixed(1)} s)"`,
		options.install ? "npm ci --ignore-scripts --no-audit --no-fund --prefer-offline >.run-on-node-npm-ci.log 2>&1 || { cat .run-on-node-npm-ci.log; exit 90; }" : ":",
		`start=$(date +%s%N); ${runCommand}; code=$?; end=$(date +%s%N)`,
		'echo "== run-on-node: exit $code after $(( (end - start) / 1000000 )) ms"',
		"exit $code",
	].join("\n");
	const code = await sshRun(t, script);
	const finished = Date.now();

	let versions = {};
	try {
		versions = JSON.parse(
			sshCapture(
				t,
				`python3 -c 'import json,subprocess as s,platform as p
def r(c):
 try: return s.run(c,capture_output=True,text=True,timeout=10).stdout.strip()
 except Exception: return None
print(json.dumps({"machine":p.node(),"kernel":p.release(),"os":r(["sh","-c",". /etc/os-release; echo $PRETTY_NAME"]),"node":r(["node","--version"]),"npm":r(["npm","--version"]),"docker":r(["docker","version","--format","{{.Server.Version}}"]),"git":r(["git","--version"]),"cpus":r(["nproc"])}))'${options.keep ? "" : `; rm -rf ${runDir}`}`,
			),
		);
	} catch (error) {
		versions = { unavailable: String(error.message) };
	}
	const record = {
		schema: "qorpera.run-on-node/v1",
		host: t.host,
		via: t.jump || null,
		environment: versions,
		source,
		command: options.command,
		install: options.install,
		run: options.keep ? runDir : run,
		startedAt: new Date(started).toISOString(),
		syncSeconds: (synced - started) / 1000,
		elapsedSeconds: (finished - started) / 1000,
		exitCode: code,
		result: code === 0 ? "passed" : "failed",
	};
	console.log(`== run-on-node record ${JSON.stringify(record)}`);
	if (options.record) writeFileSync(resolve(options.record), `${JSON.stringify(record, null, 2)}\n`);
	return code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().then(
		(code) => process.exit(code),
		(error) => {
			console.error(`run-on-node: ${error.message}`);
			process.exit(2);
		},
	);
}
