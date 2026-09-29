import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { constants, homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describePlan, planChanged, planScript } from "./run-on-node-plan.mjs";

/** Runs one test suite on the operator test machine on node 2 instead of Docker on a
 * developer Mac (contract 24.1). The working tree git would see (tracked plus untracked,
 * not ignored, uncommitted changes included) is copied to a fresh per-run directory;
 * only changed files cross the network. Output streams back and the exit code is the
 * suite's. A record of host, versions, source and elapsed time is printed at the end (24.4). */

const USAGE = `Usage: node scripts/run-on-node.mjs [options] <suite> [-- args]
       node scripts/run-on-node.mjs [options] -- <command...>

Suites: changed              what the files changed against --base need (scripts/run-on-node-plan.mjs)
        test                 npm test, the whole repository (builds the shared packages first)
        hosted-db            npm run test:hosted-db (no npm ci needed)
        npm:<script>         npm run <script>
        scripts/<file>.mjs   node scripts/<file>.mjs

Options: --install / --no-install   run npm ci --ignore-scripts first (default: yes, except hosted-db)
         --build / --no-build       then npm run build:web-sdk, which script tests import (default: only for test)
         --env NAME=VALUE           pass an environment variable (repeatable)
         --sudo                     run the command as root inside the test machine
         --keep                     keep the run directory on the test machine
         --record FILE              also write the run record as JSON to FILE
         --allow-secrets            copy untracked files that look like secrets (.env*, *.pem, keys)
         --base REF                 compare against REF for changed (default: origin/master)
         --dry-run                  print what would run, change nothing

Target (environment): QORPERA_TEST_MACHINE      default tester@10.201.0.2
                      QORPERA_TEST_MACHINE_JUMP default company41-node-02 (empty: connect directly)
                      QORPERA_TEST_MACHINE_KEY  default ~/.ssh/id_ed25519_qorpera_testvm`;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOME = "/home/tester";
/** Runner users on the test machine (guest-setup.sh creates them). Each run takes one for its whole
 * duration, so per-user kernel limits count that run alone: the coding Git sandbox caps RLIMIT_NPROC
 * at 512 tasks, which every concurrent run under one shared user exhausted together. */
export const RUNNERS = Array.from({ length: 16 }, (_, i) => `ci${String(i + 1).padStart(2, "0")}`);
/** At most this many runs execute at once, each with (vCPUs / CPU_SLOTS) vitest workers, so the slots
 * together use the machine's vCPUs: 2 each on 6 vCPUs, 4 each on 12. Measured 2026-09-29: a full npm test
 * is ~881 CPU-seconds; two full runs plus other sessions drove 6 vCPUs to load 22 and timing-bound tests
 * failed. Later runs wait in arrival order. */
export const CPU_SLOTS = 3;
const SECRET =
	/(^|\/)(\.env(\.[^/]*)?|\.envrc|\.dev\.vars|\.npmrc|\.netrc|\.pgpass|\.git-credentials|\.aws\/credentials|[^/]*\.(env|pem|p12|pfx|key|tfvars)|id_[^/.]+|credentials[^/]*\.json|service-account[^/]*\.json|[^/]*\.private\.json)$/i;

export function parseArgs(argv) {
	const options = {
		install: undefined,
		build: undefined,
		env: [],
		sudo: false,
		keep: false,
		record: null,
		allowSecrets: false,
		dryRun: false,
		base: "origin/master",
	};
	let i = 0;
	for (; i < argv.length && argv[i] !== "--" && argv[i].startsWith("--"); i++) {
		const flag = argv[i];
		if (flag === "--install") options.install = true;
		else if (flag === "--no-install") options.install = false;
		else if (flag === "--build") options.build = true;
		else if (flag === "--no-build") options.build = false;
		else if (flag === "--sudo") options.sudo = true;
		else if (flag === "--keep") options.keep = true;
		else if (flag === "--allow-secrets") options.allowSecrets = true;
		else if (flag === "--dry-run") options.dryRun = true;
		else if (flag === "--env" || flag === "--record" || flag === "--base") {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			if (flag === "--record") options.record = value;
			else if (flag === "--base") {
				if (!/^[A-Za-z0-9._/@^~][A-Za-z0-9._/@^~-]*$/.test(value)) throw new Error(`Invalid --base ${value}`);
				options.base = value;
			}
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
		if (rest[1] !== undefined && rest[1] !== "--") throw new Error(`Put suite arguments after --\n\n${USAGE}`);
		const extra = rest.slice(2);
		if (suite === "changed") {
			if (extra.length) throw new Error("changed takes no suite arguments");
			// The plan, and with it the command and the build, is made from git in main().
			return { ...options, install: options.install ?? true, build: options.build, suite, command: [] };
		}
		const base = suiteCommand(suite);
		// npm keeps --flags after the script name for itself unless they follow a literal --.
		command = base[0] === "npm" && extra.length ? [...base, "--", ...extra] : [...base, ...extra];
	}
	const build = options.build ?? (suite === "test" && options.install !== false);
	const install = options.install ?? (suite !== "hosted-db" || build);
	if (build && !install) throw new Error("--build needs --install");
	return { ...options, install, build, suite, command };
}

export function suiteCommand(suite) {
	if (suite === "test") return ["npm", "test"];
	if (suite === "hosted-db") return ["npm", "run", "test:hosted-db"];
	if (/^npm:[A-Za-z0-9:_.-]+$/.test(suite)) return ["npm", "run", suite.slice(4)];
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

/** Untracked files that look like credentials; tracked files are already in git. */
export function secretLooking(untracked) {
	return untracked.filter((file) => SECRET.test(file));
}

function git(root, args) {
	const result = spawnSync("git", ["--no-optional-locks", ...args], {
		cwd: root,
		encoding: "buffer",
		maxBuffer: 256 * 1024 * 1024,
	});
	if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
	return result.stdout;
}

function listed(root, args) {
	return git(root, ["ls-files", "-z", ...args])
		.toString("utf8")
		.split("\0")
		.filter(Boolean);
}

function exists(root, file) {
	try {
		const stat = lstatSync(join(root, file));
		return stat.isFile() || stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/** Tracked and untracked-but-not-ignored files that exist now; a deleted tracked file is left out. */
export function workingTreeFiles(root) {
	const untracked = listed(root, ["--others", "--exclude-standard"]).filter((file) => exists(root, file));
	const files = [...new Set([...listed(root, ["--cached"]), ...untracked])].filter((file) => exists(root, file)).sort();
	return { files, untracked };
}

/** Digest of exactly what is copied: path, kind, executable bit and content (or link target). */
export function treeDigest(root, files) {
	const hash = createHash("sha256");
	for (const file of files) {
		const path = join(root, file);
		const stat = lstatSync(path);
		const body = stat.isSymbolicLink()
			? `link:${readlinkSync(path)}`
			: `file:${stat.mode & 0o111 ? "x" : "-"}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
		hash.update(`${file}\0${body}\n`);
	}
	return hash.digest("hex");
}

/** Best-effort cleanup at the start of every run: runs older than a day by the UTC time in
 * their name (never by mtime: rsync -a gives a run directory the worktree's old mtime),
 * worktree copies unused for 14 days, and hosted-db containers older than 6 hours. */
export function pruneScript() {
	return [
		"set -u",
		`mkdir -p ${HOME}/runs ${HOME}/trees`,
		"cutoff=$(date -u -d '-1 day' +%Y%m%dT%H%M%S)",
		`for d in ${HOME}/runs/*/; do n=$(basename "$d"); if [[ "$n" =~ ^[0-9]{8}T[0-9]{6}- && "\${n%%-*}" < "$cutoff" ]]; then sudo -n rm -rf -- "$d"; fi; done`,
		`find ${HOME}/trees -maxdepth 1 -name '*.lock' -mtime +14 2>/dev/null | while read -r l; do flock -n "$l" sudo -n rm -rf -- "\${l%.lock}" && rm -f -- "$l"; done`,
		`for id in $(docker ps -aq --filter name=^qorpera-hosted-db- 2>/dev/null); do c=$(docker inspect -f '{{.Created}}' "$id") && [ $(( $(date +%s) - $(date -d "$c" +%s) )) -gt 21600 ] && docker rm -f "$id" >/dev/null; done`,
		"true",
	].join("\n");
}

/** One ssh session: refresh the base copy, take a free runner user under a lock held until the
 * session ends, hand it the run directory, then install and run as that user. The status file
 * carries the runner user and times back to the record. Exit codes 90 (install or build) and 91-94
 * (harness: cd, runner user, chown, CPU slot) are recorded as setup-failed. */
export function runScript({ run, runDir, treeDir, files, copySeconds, install, build, runCommand }) {
	const status = `${runDir}/.run-on-node-status`;
	const queue = "/run/lock/qorpera-test-machine-queue";
	const inner = [
		`cd ${runDir} || exit 91`,
		// A --env VITEST_MAX_WORKERS=n on the command still wins: it is set later, on the command itself.
		`export VITEST_MAX_WORKERS=$(( $(nproc) / ${CPU_SLOTS} > 0 ? $(nproc) / ${CPU_SLOTS} : 1 ))`,
		`echo "workers=$VITEST_MAX_WORKERS" >>${status}`,
		"t0=$(date +%s%N)",
		install
			? `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline >.run-on-node-npm-ci.log 2>&1 || { tail -50 .run-on-node-npm-ci.log; echo installed=0 >>${status}; exit 90; }`
			: "true",
		build
			? `npm run build:web-sdk >.run-on-node-build.log 2>&1 || { tail -50 .run-on-node-build.log; echo installed=0 >>${status}; exit 90; }`
			: "true",
		`echo "installed=1 prepare_ms=$(( ($(date +%s%N) - t0) / 1000000 ))" >>${status}`,
		`start=$(date +%s%N); ${runCommand}; code=$?; end=$(date +%s%N)`,
		`echo "suite_ms=$(( (end - start) / 1000000 ))" >>${status}`,
		'echo "== run-on-node: exit $code after $(( (end - start) / 1000000 )) ms"',
		"exit $code",
	].join("\n");
	return [
		"set -uo pipefail",
		// The base copy is only a cache: a busy or failed refresh never fails the run.
		`flock -w 60 ${treeDir}.lock rsync -a --delete ${runDir}/ ${treeDir}/ || echo "== run-on-node: base copy refresh skipped"`,
		// Arrival-ordered queue for the CPU slots: a ticket per waiting run, its name sorting by arrival.
		// The run holds a lock on its own ticket (fd 7) while it waits, so a ticket nobody holds belongs
		// to a run that died, whatever its pid became; it is dropped. Only the first ticket may take a
		// free slot. The slot lock stays on fd 9 until this session ends.
		`mkdir -p ${queue}`,
		`ticket=${queue}/$(date +%s%N)-$$; exec 7>"$ticket"; flock -n 7; trap 'rm -f "$ticket"' EXIT`,
		'slot=""; queued=$(date +%s); shown=""',
		'while [ -z "$slot" ]; do',
		`\tfor t in ${queue}/*; do [ "$t" != "$ticket" ] && [ -e "$t" ] && flock -n "$t" true 2>/dev/null && rm -f "$t"; done`,
		'\t[ -e "$ticket" ] || { exec 7>"$ticket"; flock -n 7; }',
		`\tposition=$(ls ${queue} | sort | grep -n -x -F "$(basename "$ticket")" | cut -d: -f1)`,
		'\tif [ "$position" = 1 ]; then',
		`\t\tfor candidate in $(seq 1 ${CPU_SLOTS}); do`,
		'\t\t\t{ exec 9>"/run/lock/qorpera-test-machine-slot$candidate.lock"; } 2>/dev/null || continue',
		'\t\t\tif flock -n 9; then slot=$candidate; break; fi',
		"\t\tdone",
		"\tfi",
		'\tif [ -z "$slot" ]; then',
		`\t\t[ "$position" != "$shown" ] && echo "== run-on-node: waiting for a slot (${CPU_SLOTS} runs at a time), queue position $position" && shown=$position`,
		'\t\t[ $(( $(date +%s) - queued )) -ge 7200 ] && { echo "== run-on-node: no slot free for two hours"; exit 94; }',
		"\t\tsleep 2",
		"\tfi",
		"done",
		'rm -f "$ticket"; exec 7>&-',
		'queued_s=$(( $(date +%s) - queued ))',
		'runner=""; waited=0',
		'while [ -z "$runner" ]; do',
		`\tfor candidate in ${RUNNERS.join(" ")}; do`,
		'\t\t{ exec 8>"/run/lock/qorpera-test-machine-$candidate.lock"; } 2>/dev/null || continue',
		'\t\tif flock -n 8; then runner=$candidate; break; fi',
		"\tdone",
		'\tif [ -z "$runner" ]; then',
		'\t\t[ "$waited" = 0 ] && echo "== run-on-node: every runner user is busy; waiting"',
		'\t\twaited=$((waited + 1)); [ "$waited" -ge 3600 ] && { echo "== run-on-node: no runner user free for an hour"; exit 92; }',
		"\t\tsleep 1",
		"\tfi",
		"done",
		// Holding the runner lock proves no live run uses this user: processes a killed run left behind would
		// still count against its RLIMIT_NPROC and take CPU outside the slots.
		'sudo -n pkill -KILL -u "$runner" 2>/dev/null; true',
		// The load at start and uncapped test processes (older clients run suites as tester) explain a slow
		// run. The pattern is anchored on node: this script's own shell carries the words in its command line.
		`echo "runner=$runner slot=$slot queued_s=$queued_s load=$(cut -d' ' -f1 /proc/loadavg) uncapped=$(pgrep -u tester -fc '^([^ ]*/)?node .*(vitest|--test)' || true)" >${status}`,
		`sudo -n chown -R "$runner:$runner" ${runDir} || exit 93`,
		`echo "== run-on-node: $(hostname) ${run} as $runner in slot $slot of ${CPU_SLOTS} (${files} files, copy ${copySeconds.toFixed(1)} s, queued $queued_s s)"`,
		`sudo -n -u "$runner" -H bash -c ${shellQuote(inner)}`,
	].join("\n");
}

/** `key=value` words from the status file; later lines win. */
export function parseStatus(text) {
	const status = {};
	for (const word of text.split(/\s+/)) {
		const equals = word.indexOf("=");
		if (equals > 0) status[word.slice(0, equals)] = word.slice(equals + 1);
	}
	return status;
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
		// -J would not pass BatchMode to the jump host; a non-interactive session must never prompt there.
		...(jump ? ["-o", `ProxyCommand=ssh -o BatchMode=yes -o ConnectTimeout=15 -W %h:%p ${jump}`] : []),
	];
	return { host, jump, ssh, key };
}

function sshRun(t, remoteScript) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("ssh", [...t.ssh, t.host, "bash", "-c", shellQuote(remoteScript)], { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code, signal) => resolvePromise(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1)));
	});
}

function sshCapture(t, remoteScript) {
	const result = spawnSync("ssh", [...t.ssh, t.host, "bash", "-c", shellQuote(remoteScript)], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Test machine unreachable or refused: ${(result.stderr || "").trim()}`);
	return result.stdout;
}

const VERSIONS = `python3 -c 'import json,os,subprocess as s,platform as p
def r(c):
 try: return s.run(c,capture_output=True,text=True,timeout=10).stdout.strip()
 except Exception: return None
print(json.dumps({"machine":p.node(),"kernel":p.release(),"os":r(["sh","-c",". /etc/os-release; echo $PRETTY_NAME"]),"node":r(["node","--version"]),"npm":r(["npm","--version"]),"docker":r(["docker","version","--format","{{.Server.Version}}"]),"git":r(["git","--version"]),"cpus":r(["nproc"]),"kvm":os.path.exists("/dev/kvm")}))'`;

/** Paths changed against the merge base with `base`: committed, uncommitted and untracked. */
export function changedFiles(root, base, untracked) {
	const mergeBase = git(root, ["merge-base", base, "HEAD"]).toString().trim();
	// --no-renames: a move lists its old path too, so the tests of the place it left still run.
	const tracked = git(root, ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", mergeBase])
		.toString("utf8")
		.split("\0")
		.filter(Boolean);
	return { mergeBase, files: [...new Set([...tracked, ...untracked])].sort() };
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).toString().trim();
	const t = target();
	const { files, untracked } = workingTreeFiles(root);
	const secrets = secretLooking(untracked);
	if (secrets.length && !options.allowSecrets)
		throw new Error(`Untracked files that look like secrets would be copied (use --allow-secrets): ${secrets.join(", ")}`);
	let changedPlan = null;
	if (options.suite === "changed") {
		const { mergeBase, files: changed } = changedFiles(root, options.base, untracked);
		const plan = planChanged(changed);
		for (const line of describePlan(plan, `${options.base} ${mergeBase.slice(0, 9)}, ${changed.length} files`)) console.log(line);
		changedPlan = { base: options.base, mergeBase, files: changed.length, full: plan.full, steps: plan.steps.map((step) => step.name) };
		if (!plan.steps.length) return 0;
		options.command = ["bash", "-c", planScript(plan.steps)];
		options.build = options.build ?? plan.build;
		if (options.build && !options.install) throw new Error("--build needs --install");
	}
	const source = {
		head: git(root, ["rev-parse", "HEAD"]).toString().trim(),
		dirty: git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length > 0,
		files: files.length,
		untracked: untracked.length,
		treeSha256: treeDigest(root, files),
	};
	const tree = createHash("sha256").update(`${hostname()}:${root}`).digest("hex").slice(0, 16);
	const run = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-${process.pid}-${randomBytes(4).toString("hex")}`;
	const runDir = `${HOME}/runs/${run}`;
	const treeDir = `${HOME}/trees/${tree}`;
	const env = options.env.map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
	const command = options.command.map(shellQuote).join(" ");
	const runCommand = options.sudo
		? `sudo -n env VITEST_MAX_WORKERS="$VITEST_MAX_WORKERS" ${env} PATH="$PATH" ${command}`
		: `${env ? `env ${env} ` : ""}${command}`;
	if (options.dryRun) {
		console.log(
			JSON.stringify(
				{ target: t.host, via: t.jump || null, runDir, treeDir, install: options.install, runCommand, source },
				null,
				2,
			),
		);
		return 0;
	}
	if (!existsSync(t.key)) throw new Error(`Missing test machine key ${t.key}`);
	if (untracked.length) console.error(`== run-on-node: copying ${untracked.length} untracked file(s) too`);

	const started = Date.now();
	sshCapture(t, `${pruneScript()}\nmkdir -p ${runDir} ${treeDir}\ntouch ${treeDir}.lock`);
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
			// The base copy is read under a shared lock; its refresh below takes the exclusive one.
			`--rsync-path=flock -s ${treeDir}.lock rsync`,
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

	const code = await sshRun(
		t,
		runScript({
			run,
			runDir,
			treeDir,
			files: files.length,
			copySeconds: (synced - started) / 1000,
			install: options.install,
			build: options.build,
			runCommand,
		}),
	);
	const finished = Date.now();
	let status = {};
	try {
		status = parseStatus(sshCapture(t, `cat ${runDir}/.run-on-node-status 2>/dev/null || true`));
	} catch {
		// The record says the status is unknown.
	}

	let environment;
	try {
		environment = JSON.parse(sshCapture(t, VERSIONS));
	} catch (error) {
		environment = { unavailable: String(error.message) };
	}
	if (!options.keep) {
		try {
			sshCapture(t, `sudo -n rm -rf -- ${runDir}`);
		} catch (error) {
			console.error(`run-on-node: cleanup of ${runDir} failed (pruned after a day): ${error.message}`);
		}
	}
	const record = {
		schema: "qorpera.run-on-node/v1",
		host: t.host,
		via: t.jump || null,
		environment,
		source,
		command: options.command,
		sudo: options.sudo,
		install: options.install,
		build: options.build,
		run: options.keep ? runDir : run,
		runner: status.runner ?? null,
		cpuSlot: status.slot ? Number(status.slot) : null,
		queuedSeconds: status.queued_s ? Number(status.queued_s) : null,
		vitestMaxWorkers: Number(options.env.findLast(([name]) => name === "VITEST_MAX_WORKERS")?.[1] ?? status.workers ?? Number.NaN) || null,
		loadAtStart: status.load ? Number(status.load) : null,
		uncappedTestProcesses: status.uncapped ? Number(status.uncapped) : null,
		...(changedPlan ? { changed: changedPlan } : {}),
		startedAt: new Date(started).toISOString(),
		copySeconds: (synced - started) / 1000,
		prepareSeconds: status.prepare_ms ? Number(status.prepare_ms) / 1000 : null,
		suiteSeconds: status.suite_ms ? Number(status.suite_ms) / 1000 : null,
		elapsedSeconds: (finished - started) / 1000,
		exitCode: code,
		result:
			status.installed === "1"
				? code === 0
					? "passed"
					: "failed"
				: code === 0 && !status.runner
					? "unknown"
					: "setup-failed",
	};
	console.log(`== run-on-node record ${JSON.stringify(record)}`);
	if (options.record) {
		try {
			writeFileSync(resolve(options.record), `${JSON.stringify(record, null, 2)}\n`);
		} catch (error) {
			console.error(`run-on-node: could not write ${options.record}: ${error.message}`);
		}
	}
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
