import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { constants, homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ALL_STARTED, describePlan, planChanged, planScript, STOP, splitPlan } from "./run-on-node-plan.mjs";
import {
	commitPushed,
	machineLabel,
	postStatus,
	repoSlug,
	statusContext,
	statusDecision,
	statusDescription,
	statusState,
} from "./run-on-node-status.mjs";

/** Runs one test suite on one of the operator test machines (one VM per node) instead of
 * Docker on a developer Mac (contract 24.1). The run takes the machine with the most free
 * slots. The working tree git would see (tracked plus untracked, not ignored, uncommitted
 * changes included) is copied to a fresh per-run directory there; only changed files cross
 * the network. Output streams back and the exit code is the suite's. A record of machine,
 * host, versions, source and elapsed time is printed at the end (24.4). */

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
         --machine NAME             run on this machine only (node02, node01)
         --front                    wait at the front of the CPU lane's queue, ahead of every run without it
                                    (pr-loop's batch runs, which test every approved head at once)
         --cores N                  changed: run the steps side by side within N cores, their tree-wide parts
                                    first and alone (default: one step at a time). With --front the run takes
                                    up to 3 slots as they free (one such run per machine); otherwise it keeps
                                    to its one slot's cores
         --parts N                  changed: split the steps into N parts by their CPU work, each a run of its own on
                                    its own machine, all at once (N at most the machines' count). One exit code, status
                                    and record: the run passes only if every part passed. With one machine open, or
                                    --machine, one part
         --fail-fast                changed: stop at the first failed step: no step starts after it, the steps running
                                    side by side end, and so do the other parts' (pr-loop's batch runs, which are
                                    bisected when they fail). Without --cores, the shortest steps first
         --tree NAME               copy against the machine's shared base copy NAME, not this checkout's own,
                                    comparing file contents (for checkouts made fresh per run, such as
                                    pr-loop's merged trees)
         --no-status                do not post the result as a GitHub status on the commit
         --dry-run                  print what would run and where, change nothing

Machines: node02 (tester@10.201.0.2 via company41-node-02), node01 (tester@10.201.0.3 via company41-node-01).
A run asks each how many runs it holds and takes the one with the most free slots (ties: this order). If that
machine fails before the suite starts (unreachable, copy failed), the run moves to the next one.
hosted-db -- --only <tests> takes the quick lane: one slot and queue of its own, so it never waits behind long runs.
A --front run takes the machine with the fewest runs ahead of it: those in its slots and other --front runs.

A named suite run on a clean, pushed commit posts its result as the commit status qorpera-ci/<suite>
(pending while it runs), so the PR shows it as a check. Uncommitted changes or ad-hoc commands post none.

Target (environment): QORPERA_TEST_MACHINE      one other machine instead of the list (default tester@10.201.0.2)
                      QORPERA_TEST_MACHINE_JUMP its jump host (default company41-node-02; empty: connect directly)
                      QORPERA_TEST_MACHINE_KEY  default ~/.ssh/id_ed25519_qorpera_testvm`;

/** The operator test machines, one VM per node (deploy/test-machine/README.md), each reached through its node's
 * own SSH login. Both nodes' bridges are 10.201.0.0/24; each VM has its own address there, so each has its own
 * line in the known-hosts file. On a tie the earlier machine wins. */
export const MACHINES = [
	{ name: "node02", host: "tester@10.201.0.2", jump: "company41-node-02" },
	{ name: "node01", host: "tester@10.201.0.3", jump: "company41-node-01" },
];
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOME = "/home/tester";
const LOCKS = "/run/lock";
/** A marker per run from its first SSH call until it takes a queue ticket, so probes count runs that are still
 * being copied (seconds, a minute for a first copy) and a burst of starts does not all choose one machine. */
const ARRIVING = `${HOME}/arriving`;
/** Inside a machine, CLOSED takes it out of the automatic choice (maintenance, removal); --machine still reaches
 * it. It survives a reboot. Runs already queued there still run. A machine without SET_UP, which guest-setup.sh
 * writes last, counts as closed too: its runner users may not exist yet. */
export const CLOSED = "/etc/qorpera-test-machine-closed";
export const SET_UP = "/etc/qorpera-test-machine-versions";
/** A probe answers in about a second (0.6-0.9 s measured to node 2). Its connection, the jump's included, must
 * reach the machine's SSH banner within PROBE_CONNECT_S: a jump that cannot reach its machine either fails at
 * once ("Network is unreachable") or hangs, and a hang must not hold every run for the jump's own 15 s. Once one
 * machine has answered with a free slot, the others get PROBE_GRACE_MS more; a machine that is down then costs a
 * run about that. PROBE_TIMEOUT_MS ends every probe. */
const PROBE_CONNECT_S = 6;
export const PROBE_GRACE_MS = 2_000;
export const PROBE_TIMEOUT_MS = 12_000;
/** Before a run moves to another machine or starts its suite, the event loop gets this long to act on a signal
 * that arrived during a synchronous copy: an interrupted run must stop, not start a suite somewhere. */
const SIGNAL_TURN_MS = 100;
/** Runner users on the test machine (guest-setup.sh creates them). Each run takes one for its whole
 * duration, so per-user kernel limits count that run alone: the coding Git sandbox caps RLIMIT_NPROC
 * at 512 tasks, which every concurrent run under one shared user exhausted together. */
export const RUNNERS = Array.from({ length: 16 }, (_, i) => `ci${String(i + 1).padStart(2, "0")}`);
/** At most this many runs execute at once, each with (vCPUs / CPU_SLOTS) vitest workers, so the slots
 * together use the machine's vCPUs: 2 each on 10 or 12 vCPUs. Measured 2026-09-29: a full npm test
 * is ~881 CPU-seconds; two full runs plus other sessions drove 6 vCPUs to load 22 and timing-bound tests
 * failed. Measured 2026-10-14 with 3 slots: both 10-vCPU machines had all 3 busy and 3-4 runs waiting at
 * load 4-6, ~12 GiB of 15.5 available, no memory pressure and no OOM kill. Measured 2026-10-15 with 4 slots:
 * all 4 busy and 11-15 runs waiting on each machine, load 6-8, the vCPUs 26-34% busy on node02 and 36-83%
 * (about 55% on average) on node01 over a minute, iowait at most 4%, ~11.5 GiB available. A fifth run keeps
 * 2 workers each. Later runs wait in arrival order. */
export const CPU_SLOTS = 5;
/** A hosted-db run narrowed with --only (a few SQL tests, about 15 s of work) takes one of QUICK_SLOTS slots of
 * its own, with its own arrival-ordered queue: on 14 Oct such runs waited 5-20 minutes behind the CPU slots'
 * 20-minute changed runs. */
export const QUICK_SLOTS = 1;
/** Each lane's slot count, slot lock files and queue directory under LOCKS. */
const LANES = {
	cpu: { name: "CPU lane", slots: CPU_SLOTS, slot: "qorpera-test-machine-slot", queue: "qorpera-test-machine-queue" },
	quick: { name: "quick lane", slots: QUICK_SLOTS, slot: "qorpera-test-machine-quick-slot", queue: "qorpera-test-machine-quick-queue" },
};
/** The start of a --front run's queue ticket name. pr-loop's batch run tests every approved head in one `changed`,
 * so its wait delays every one of them: on 15 Oct the CPU lane's queue wait had a median of 14 minutes. */
export const FRONT = "0-";
/** A --front --cores run (pr-loop's batch, its steps side by side) may hold up to this many of its machine's CPU slots:
 * it starts in one and takes the others as they free, ahead of every run that came after it. One such run per machine
 * at a time holds WIDE; any other --cores run keeps its one slot's cores. The coordinator's decision of 16 Oct: 6 of
 * a 10-vCPU machine's cores for the batch, the other slots for everyone else. */
export const WIDE_SLOTS = 3;
const WIDE = `${LOCKS}/qorpera-test-machine-wide.lock`;
/** A --cores run's cores file (the start of its name; the run's name follows): how many cores its slots give it now. */
const CORES = `${LOCKS}/qorpera-test-machine-cores-`;
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
		noStatus: false,
		dryRun: false,
		base: "origin/master",
		machine: null,
		tree: null,
		front: false,
		cores: null,
		parts: null,
		failFast: false,
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
		else if (flag === "--no-status") options.noStatus = true;
		else if (flag === "--dry-run") options.dryRun = true;
		else if (flag === "--front") options.front = true;
		else if (flag === "--fail-fast") options.failFast = true;
		else if (["--env", "--record", "--base", "--machine", "--tree", "--cores", "--parts"].includes(flag)) {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			if (flag === "--record") options.record = value;
			else if (flag === "--cores") {
				if (!/^[1-9][0-9]?$/.test(value)) throw new Error(`Invalid --cores ${value}`);
				options.cores = Number(value);
			}
			else if (flag === "--parts") {
				if (!/^[1-9]$/.test(value) || Number(value) > MACHINES.length)
					throw new Error(`Invalid --parts ${value} (1 to ${MACHINES.length}, one part per machine)`);
				options.parts = Number(value);
			}
			else if (flag === "--tree") {
				// Never NAME.lock: that is the lock file of the base copy NAME.
				if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || value.endsWith(".lock")) throw new Error(`Invalid --tree ${value}`);
				options.tree = value;
			}
			else if (flag === "--machine") {
				if (!MACHINES.some((machine) => machine.name === value))
					throw new Error(`Unknown machine ${value} (${MACHINES.map((machine) => machine.name).join(", ")})`);
				options.machine = value;
			} else if (flag === "--base") {
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
	let extra = [];
	if (options.cores && rest[0] !== "changed") throw new Error("--cores is for changed");
	if (options.parts && rest[0] !== "changed") throw new Error("--parts is for changed");
	if (options.failFast && rest[0] !== "changed") throw new Error("--fail-fast is for changed");
	if (rest[0] === "--") {
		command = rest.slice(1);
		if (command.length === 0) throw new Error(USAGE);
	} else {
		suite = rest[0];
		if (!suite) throw new Error(USAGE);
		if (rest[1] !== undefined && rest[1] !== "--") throw new Error(`Put suite arguments after --\n\n${USAGE}`);
		extra = rest.slice(2);
		if (suite === "changed") {
			if (extra.length) throw new Error("changed takes no suite arguments");
			// The plan, and with it the command and the build, is made from git in main().
			return { ...options, install: options.install ?? true, build: options.build, suite, command: [], quick: false, plain: plain(options, suite, extra) };
		}
		const base = suiteCommand(suite);
		// npm keeps --flags after the script name for itself unless they follow a literal --.
		command = base[0] === "npm" && extra.length ? [...base, "--", ...extra] : [...base, ...extra];
	}
	const build = options.build ?? (suite === "test" && options.install !== false);
	const install = options.install ?? (suite !== "hosted-db" || build);
	if (build && !install) throw new Error("--build needs --install");
	const quick = suite === "hosted-db" && extra.some((arg) => arg === "--only" || arg.startsWith("--only="));
	if (quick && options.front) throw new Error("--front is for the CPU lane; a hosted-db --only run has the quick lane");
	return { ...options, install, build, suite, command, quick, plain: plain(options, suite, extra) };
}

/** The suite exactly as named: no suite arguments, environment, sudo or install/build override. Only such a
 * run may speak for the suite on the commit (a narrowed run would claim the whole suite). */
function plain(options, suite, extra) {
	return (
		suite !== null &&
		!extra.length &&
		!options.env.length &&
		!options.sudo &&
		options.install === undefined &&
		options.build === undefined
	);
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
 * worktree copies unused for 3 days (each worktree has its own copy, and with many sessions 14 days filled
 * node02's disk on 2026-10-09), hosted-db containers older than 6 hours, and the cores files of --cores runs killed
 * before they could remove them (/run/lock is a small tmpfs every lock lives on). */
export function pruneScript() {
	return [
		"set -u",
		`mkdir -p ${HOME}/runs ${HOME}/trees`,
		"cutoff=$(date -u -d '-1 day' +%Y%m%dT%H%M%S)",
		`for d in ${HOME}/runs/*/; do n=$(basename "$d"); if [[ "$n" =~ ^[0-9]{8}T[0-9]{6}- && "\${n%%-*}" < "$cutoff" ]]; then sudo -n rm -rf -- "$d"; fi; done`,
		`for f in ${ARRIVING}/*; do n=$(basename "$f"); if [[ "$n" =~ ^[0-9]{8}T[0-9]{6}- && "\${n%%-*}" < "$cutoff" ]]; then rm -f -- "$f"; fi; done`,
		`for f in ${CORES}*; do n=\${f#${CORES}}; if [[ "$n" =~ ^[0-9]{8}T[0-9]{6}- && "\${n%%-*}" < "$cutoff" ]]; then rm -f -- "$f"; fi; done`,
		`find ${HOME}/trees -maxdepth 1 -name '*.lock' -mtime +2 2>/dev/null | while read -r l; do flock -n "$l" sudo -n rm -rf -- "\${l%.lock}" && rm -f -- "$l"; done`,
		`for id in $(docker ps -aq --filter name=^qorpera-hosted-db- 2>/dev/null); do c=$(docker inspect -f '{{.Created}}' "$id") && [ $(( $(date +%s) - $(date -d "$c" +%s) )) -gt 21600 ] && docker rm -f "$id" >/dev/null; done`,
		"true",
	].join("\n");
}

/** How rsync tells a file equal to the base copy's. A checkout's own base copy holds only its earlier files,
 * so rsync's quick check (size and mtime) is enough. A shared one (--tree) holds other checkouts' files, where
 * an equal size and mtime proves nothing (fresh checkouts made in the same second), so it compares contents. */
export function baseCopyCompare(shared) {
	return shared ? ["--checksum"] : [];
}

/** The command as runScript runs it, with its --env settings. sudo (--sudo) drops the environment, so the
 * variables the session sets for the command go along by name: the vitest workers, and a --cores run's cores
 * file (without it the steps would not know the slots' cores, nor write the all-started marker). */
export function runCommandLine({ command, env = [], sudo = false, cores = null }) {
	const settings = env.map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
	const line = command.map(shellQuote).join(" ");
	return sudo
		? `sudo -n env VITEST_MAX_WORKERS="$VITEST_MAX_WORKERS"${cores ? ' QORPERA_RUN_CORES_FILE="$QORPERA_RUN_CORES_FILE"' : ""} ${settings} PATH="$PATH" ${line}`
		: `${settings ? `env ${settings} ` : ""}${line}`;
}

/** One ssh session: refresh the base copy, take a free runner user under a lock held until the
 * session ends, hand it the run directory, then install and run as that user. The status file
 * carries the runner user and times back to the record. A quick run waits for the quick lane's slots, any other
 * for the CPU lane's; a `front` run waits ahead of every run without it. A `cores` run (changed --cores) tells its
 * steps how many cores its slots give it in its cores file; a `front` one takes up to WIDE_SLOTS slots (growScript).
 * Exit codes 90 (install or build) and 91-94 (harness: cd, runner user, chown, slot) are recorded as setup-failed. */
export function runScript({ run, runDir, treeDir, shared = false, files, copySeconds, install, build, runCommand, quick, front = false, cores = null }) {
	const status = `${runDir}/.run-on-node-status`;
	const lane = quick ? LANES.quick : LANES.cpu;
	const queue = `${LOCKS}/${lane.queue}`;
	const inner = [
		`cd ${runDir} || exit 91`,
		// A --env VITEST_MAX_WORKERS=n on the command still wins: it is set later, on the command itself.
		`export VITEST_MAX_WORKERS=$(( $(nproc) / ${CPU_SLOTS} > 0 ? $(nproc) / ${CPU_SLOTS} : 1 ))`,
		...(cores ? [`export QORPERA_RUN_CORES_FILE=${CORES}${run}`] : []),
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
		`flock -w 60 ${treeDir}.lock ${["rsync", "-a", "--delete", ...baseCopyCompare(shared), `${runDir}/`, `${treeDir}/`].join(" ")} || echo "== run-on-node: base copy refresh skipped"`,
		// Arrival-ordered queue for the lane's slots: a ticket per waiting run, its name sorting by arrival.
		// The run holds a lock on its own ticket (fd 7) while it waits, so a ticket nobody holds belongs
		// to a run that died, whatever its pid became; it is dropped. Only the first ticket may take a
		// free slot. The slot lock stays on fd 9 until this session ends.
		`mkdir -p ${queue}`,
		// Only a probe or another run's cleanup can hold this new ticket, and only for an instant: wait it out.
		// Other tickets' names start with the time in nanoseconds (1...), so a front run's 0- sorts ahead of all of
		// them, front runs among themselves by arrival; older clients' scripts sort and wait the same way.
		`ticket=${queue}/${front ? FRONT : ""}$(date +%s%N)-$$; exec 7>"$ticket"; flock 7; trap 'rm -f "$ticket"' EXIT`,
		// Queued now: probes count the ticket instead of the copy marker.
		`rm -f ${ARRIVING}/${run}`,
		'slot=""; queued=$(date +%s); shown=""',
		'while [ -z "$slot" ]; do',
		`\tfor t in ${queue}/*; do [ "$t" != "$ticket" ] && [ -e "$t" ] && flock -n "$t" true 2>/dev/null && rm -f "$t"; done`,
		'\t[ -e "$ticket" ] || { exec 7>"$ticket"; flock 7; }',
		`\tposition=$(ls ${queue} | sort | grep -n -x -F "$(basename "$ticket")" | cut -d: -f1)`,
		'\tif [ "$position" = 1 ]; then',
		`\t\tfor candidate in $(seq 1 ${lane.slots}); do`,
		`\t\t\t{ exec 9>"${LOCKS}/${lane.slot}$candidate.lock"; } 2>/dev/null || continue`,
		'\t\t\tif flock -n 9; then slot=$candidate; break; fi',
		"\t\tdone",
		"\tfi",
		'\tif [ -z "$slot" ]; then',
		`\t\t[ "$position" != "$shown" ] && echo "== run-on-node: waiting for a slot in the ${lane.name} (${lane.slots} run${lane.slots === 1 ? "" : "s"} at a time), queue position $position" && shown=$position`,
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
		`echo "== run-on-node: $(hostname) ${run} as $runner in slot $slot of ${lane.slots} in the ${lane.name}${front ? " from the front of its queue" : ""} (${files} files, copy ${copySeconds.toFixed(1)} s, queued $queued_s s)"`,
		...(cores
			? [
					// The cores the run's slots give it, which its steps read (planScript): one slot's to start with.
					`per=$(( $(nproc) / ${CPU_SLOTS} > 0 ? $(nproc) / ${CPU_SLOTS} : 1 )); cores_file=${CORES}${run}; (umask 022; echo "$per" >"$cores_file"); trap 'rm -f "$ticket" "$cores_file"' EXIT`,
					...(front
						? [
								growScript({ allStarted: `${runDir}/${ALL_STARTED}` }),
								`want=$(( (${cores} + per - 1) / per )); [ "$want" -gt ${WIDE_SLOTS} ] && want=${WIDE_SLOTS}`,
								// grow's stdin is a pipe only this session holds (sudo closes it for the command), so it ends with the session.
								'if [ "$want" -gt 1 ]; then',
								`\tif { exec 6>"${WIDE}"; } 2>/dev/null && flock -n 6; then echo "== run-on-node: side by side in up to $want slots of $per cores, taking the others as they free"; exec 4> >(grow)`,
								`\telse echo "== run-on-node: another --front run holds this machine's extra slots: side by side in this one slot ($per cores)"; fi`,
								"fi",
							]
						: []),
				]
			: []),
		`sudo -n -u "$runner" -H bash -c ${shellQuote(inner)}`,
	].join("\n");
}

/** The bash function `grow` of a --front --cores run: it takes up to `$want` of the CPU lane's slots in all, the
 * session's first included, and keeps `$cores_file` at the cores they give (`$per` each). It waits like a queued run,
 * with a front ticket of its own (fd 7) named by the time it starts, so --front runs that came earlier go first and
 * every other run after, and it drops dead tickets as they do. It stops waiting once every step has started
 * (`allStarted`), and keeps the slots it took until its stdin ends: run as `exec 4> >(grow)`, that pipe ends with the
 * session's last process, so no slot outlives the run. */
export function growScript({ locks = LOCKS, allStarted }) {
	const queue = `${locks}/${LANES.cpu.queue}`;
	return [
		"grow() {",
		// The session's own locks stay the session's: the wide lock (fd 6), the runner user (fd 8) and its first slot (fd 9).
		"\texec 6>&- 8>&- 9>&-; umask 022",
		`\theld=1; more=${queue}/${FRONT}$(date +%s%N)-$$-more; exec 7>"$more"; flock 7; trap 'rm -f "$more" "$cores_file" "$cores_file.tmp"' EXIT`,
		`\twhile [ "$held" -lt "$want" ] && [ ! -e ${shellQuote(allStarted)} ]; do`,
		`\t\tfor t in ${queue}/*; do [ "$t" != "$more" ] && [ -e "$t" ] && flock -n "$t" true 2>/dev/null && rm -f "$t"; done`,
		'\t\t[ -e "$more" ] || { exec 7>"$more"; flock 7; }',
		`\t\tposition=$(ls ${queue} | sort | grep -n -x -F "$(basename "$more")" | cut -d: -f1)`,
		'\t\tif [ "$position" = 1 ]; then',
		`\t\t\tfor candidate in $(seq 1 ${CPU_SLOTS}); do`,
		// A new descriptor cannot lock the session's own slot either: flock locks conflict between open files.
		`\t\t\t\t{ exec {fd}>"${locks}/${LANES.cpu.slot}$candidate.lock"; } 2>/dev/null || continue`,
		'\t\t\t\tif flock -n "$fd"; then',
		'\t\t\t\t\theld=$(( held + 1 )); echo $(( held * per )) >"$cores_file.tmp" && mv -f "$cores_file.tmp" "$cores_file"',
		'\t\t\t\t\techo "== run-on-node: slot $candidate too: $held slots, $(( held * per )) cores"',
		'\t\t\t\t\t[ "$held" -lt "$want" ] || break',
		"\t\t\t\telse exec {fd}>&-; fi",
		"\t\t\tdone",
		"\t\tfi",
		// The wait ends early when stdin does (read's status 1, a timeout's is over 128): the session is over.
		'\t\t[ "$held" -lt "$want" ] && { read -r -t 2 _; [ $? -gt 128 ] || return 0; }',
		"\tdone",
		'\trm -f "$more"; exec 7>&-',
		'\t[ "$held" -lt "$want" ] && echo "== run-on-node: every step has started: no more slots ($held of $want)"',
		"\twhile read -r _; do :; done",
		"}",
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

/** Whether QORPERA_TEST_MACHINE* points the run at one other machine instead of the list. */
export function customTarget(env) {
	return Boolean(env.QORPERA_TEST_MACHINE) || env.QORPERA_TEST_MACHINE_JUMP !== undefined;
}

/** The machines a run may use, in tie-break order: --machine's, the one QORPERA_TEST_MACHINE* names, or all. */
export function candidateMachines(machine, env) {
	if (customTarget(env)) {
		if (machine) throw new Error("--machine and QORPERA_TEST_MACHINE* both choose the machine; use one");
		return [
			{
				name: "custom",
				host: env.QORPERA_TEST_MACHINE || MACHINES[0].host,
				jump: env.QORPERA_TEST_MACHINE_JUMP ?? MACHINES[0].jump,
			},
		];
	}
	return machine ? MACHINES.filter((candidate) => candidate.name === machine) : MACHINES;
}

/** Read-only: how many of each lane's slots on the machine runs hold, how many runs wait in each lane's queue for
 * one, how many are still being copied there, and whether it is closed. A lock is opened for reading (never
 * created) and tried once: a held one counts, a free one is held for an instant only (a run taking a slot right
 * then tries the next and, if none is free, retries 2 s later), and an unheld queue ticket belongs to a run that
 * died. A copy marker counts for 10 minutes; a killed copy's marker ages out. */
export function probeScript({ locks, closed, setUp, arriving }) {
	const count = (lane, busy, waiting) => [
		`for i in $(seq 1 ${lane.slots}); do { flock -n 5 || ${busy}=$((${busy} + 1)); } 2>/dev/null 5<${shellQuote(`${locks}/${lane.slot}`)}"$i.lock"; done`,
		`for t in ${shellQuote(`${locks}/${lane.queue}`)}/*; do { flock -n 5 || ${waiting}=$((${waiting} + 1)); } 2>/dev/null 5<"$t"; done`,
	];
	return [
		`busy=0; waiting=0; quick_busy=0; quick_waiting=0; closed=0; setup=0; [ -e ${shellQuote(closed)} ] && closed=1; [ -e ${shellQuote(setUp)} ] && setup=1`,
		...count(LANES.cpu, "busy", "waiting"),
		...count(LANES.quick, "quick_busy", "quick_waiting"),
		// The CPU lane's waiting front runs, counted in `waiting` too. With none, the unmatched pattern opens no file.
		`front_waiting=0; for t in ${shellQuote(`${locks}/${LANES.cpu.queue}/${FRONT}`)}*; do { flock -n 5 || front_waiting=$((front_waiting + 1)); } 2>/dev/null 5<"$t"; done`,
		`arriving=$(( $(find ${shellQuote(arriving)} -maxdepth 1 -type f -mmin -10 2>/dev/null | wc -l) ))`,
		'echo "busy=$busy waiting=$waiting quick_busy=$quick_busy quick_waiting=$quick_waiting arriving=$arriving front_waiting=$front_waiting closed=$closed setup=$setup cpus=$(nproc) load=$(cut -d" " -f1 /proc/loadavg)"',
	].join("\n");
}

/** Free slots in the run's lane after running and queued runs, and in the CPU lane after arriving ones too;
 * negative when runs wait. A front run counts only running runs and the front runs it would queue behind. */
function free(probe, quick, front = false) {
	if (quick) return QUICK_SLOTS - probe.quickBusy - probe.quickWaiting;
	return front ? CPU_SLOTS - probe.busy - probe.frontWaiting : CPU_SLOTS - probe.busy - probe.waiting - probe.arriving;
}

/** Open to the automatic choice: answered, not closed by an operator, and set up. */
function open(probe) {
	return probe.unreachable === undefined && !probe.closed && probe.setUp;
}

/** Machines that answered their probe, best first: the most free slots in the run's lane, then list order.
 * Unreachable machines are left out, and closed ones unless the run named its machine. */
export function rankMachines(probes, pinned, quick, front = false) {
	return probes
		.map((probe, index) => ({ probe, index }))
		.filter(({ probe }) => probe.unreachable === undefined && (pinned || open(probe)))
		.sort((a, b) => free(b.probe, quick, front) - free(a.probe, quick, front) || a.index - b.index)
		.map(({ probe }) => probe);
}

/** The order a run tries machines in: those that answered, best first. Only when none of them can take the run
 * are the machines that did not answer tried, in list order (a probe has a short budget; the copy's own
 * connection may still get through). A closed machine is never tried unless the run named it. */
export function runOrder(probes, pinned, quick, front = false) {
	const answered = rankMachines(probes, pinned, quick, front).map((probe) => probe.name);
	return answered.length ? answered : probes.filter((probe) => probe.unreachable !== undefined).map((probe) => probe.name);
}

/** Asks every machine at once with `ask(machine, signal)`, which settles when asked to stop. Once one machine has
 * answered with a free slot (in the quick lane for a `quick` run, ahead of the queue for a `front` one) the others
 * get `graceMs` more; `timeoutMs` ends every probe. */
export async function probeAll(machines, ask, { graceMs, timeoutMs, quick, front = false }) {
	const stop = new AbortController();
	const timeout = setTimeout(() => stop.abort(new Error(`no answer in ${timeoutMs / 1000} s`)), timeoutMs);
	let grace = null;
	try {
		return await Promise.all(
			machines.map((machine) =>
				ask(machine, stop.signal).then((answer) => {
					if (!grace && open(answer) && free(answer, quick, front) > 0)
						grace = setTimeout(
							() => stop.abort(new Error(`no answer within ${graceMs / 1000} s of ${answer.name}'s`)),
							graceMs,
						);
					return answer;
				}),
			),
		);
	} finally {
		clearTimeout(timeout);
		clearTimeout(grace);
	}
}

/** One machine per run: the first of `ranked` that takes the copy. A machine that fails before the suite starts
 * (unreachable, copy refused) costs only time, so the run moves to the next and `passOver` reports it; the last
 * failure, and a copy a signal ended (`final`), are thrown. The event loop gets a turn first, so an interrupt
 * stops the run rather than moving it. A suite that has started is never repeated elsewhere. */
export async function firstTaking(ranked, copy, passOver) {
	const earlier = [];
	for (const [index, machine] of ranked.entries()) {
		try {
			copy(machine);
			return machine;
		} catch (error) {
			if (index === ranked.length - 1 || error.final) {
				if (earlier.length) error.message = `${error.message} (before: ${earlier.join("; ")})`;
				throw error;
			}
			earlier.push(`${machine.name}: ${error.message}`);
			await signalTurn();
			passOver(machine, error, ranked[index + 1]);
		}
	}
	throw new Error("No test machine to run on");
}

function signalTurn() {
	return new Promise((resolveTurn) => setTimeout(resolveTurn, SIGNAL_TURN_MS));
}

/** One line for the log: each machine's slots and queues, or why it did not answer. */
export function describeProbes(probes) {
	return probes
		.map((probe) =>
			probe.unreachable === undefined
				? `${probe.name}${probe.closed ? " closed," : probe.setUp ? "" : " not set up,"} ${probe.busy}/${CPU_SLOTS} slots busy, ${probe.waiting} waiting${probe.frontWaiting ? ` (${probe.frontWaiting} at the front)` : ""}${probe.arriving ? `, ${probe.arriving} arriving` : ""}, quick ${probe.quickBusy}/${QUICK_SLOTS}${probe.quickWaiting ? ` + ${probe.quickWaiting} waiting` : ""}`
				: `${probe.name} unreachable (${probe.unreachable})`,
		)
		.join("; ");
}

function sshArgs(machine, key) {
	return [
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
		// A machine that cannot be reached fails in seconds rather than at the kernel's connect timeout.
		"-o",
		"ConnectTimeout=15",
		"-i",
		key,
		// -J would not pass BatchMode to the jump host; a non-interactive session must never prompt there.
		...(machine.jump ? ["-o", `ProxyCommand=ssh -o BatchMode=yes -o ConnectTimeout=15 -W %h:%p ${machine.jump}`] : []),
	];
}

/** One probe over SSH. Its own process group, so that stopping it also ends the jump's ssh, which shares its
 * stderr and would otherwise keep the probe from closing. */
function probeOverSsh(machine, key, signal) {
	return new Promise((resolvePromise) => {
		const script = probeScript({ locks: LOCKS, closed: CLOSED, setUp: SET_UP, arriving: ARRIVING });
		const child = spawn(
			"ssh",
			// ssh keeps the first value given for an option: the probe's shorter connect time goes first.
			["-o", `ConnectTimeout=${PROBE_CONNECT_S}`, ...sshArgs(machine, key), machine.host, "bash", "-c", shellQuote(script)],
			{ stdio: ["ignore", "pipe", "pipe"], detached: true },
		);
		let out = "";
		let err = "";
		let settled = false;
		const settle = (answer) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", stop);
			resolvePromise(answer);
		};
		const unreachable = (reason) => settle({ name: machine.name, unreachable: reason.slice(0, 200) });
		const stop = () => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone, or never started.
			}
			child.stdout.destroy();
			child.stderr.destroy();
			unreachable(String(signal.reason?.message ?? signal.reason));
		};
		if (signal.aborted) stop();
		else signal.addEventListener("abort", stop, { once: true });
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		child.on("error", (error) => unreachable(error.message));
		child.on("close", (code) => {
			const answer = parseStatus(out);
			const counts = ["busy", "waiting", "quick_busy", "quick_waiting", "arriving", "front_waiting"].map((name) => answer[name] ?? "");
			if (code === 0 && counts.every((count) => /^\d+$/.test(count)))
				settle({
					name: machine.name,
					busy: Number(answer.busy),
					waiting: Number(answer.waiting),
					quickBusy: Number(answer.quick_busy),
					quickWaiting: Number(answer.quick_waiting),
					arriving: Number(answer.arriving),
					frontWaiting: Number(answer.front_waiting),
					closed: answer.closed === "1",
					setUp: answer.setup === "1",
					cpus: Number(answer.cpus) || null,
					load: Number(answer.load) || 0,
				});
			else if (code === 0) unreachable(`unexpected answer: ${out.trim().slice(0, 120)}`);
			// The jump's own line ("open failed: connect failed: ...") comes before ssh's "Connection closed".
			else unreachable(err.split("\n").map((line) => line.trim()).filter(Boolean).join(" / ") || `exit ${code}`);
		});
	});
}

/** Runs the script over ssh with this process's terminal. One of a run's several parts (`whole`) reads no input, and
 * hands its output on whole (wholeBlocks), its stderr in order with its stdout, so two parts' output never mixes inside a
 * line or a step. */
function sshRun(t, remoteScript, whole = false) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("ssh", [...t.ssh, t.host, "bash", "-c", shellQuote(whole ? `exec 2>&1\n${remoteScript}` : remoteScript)], {
			stdio: whole ? ["ignore", "pipe", "pipe"] : "inherit",
		});
		const out = whole ? wholeBlocks((text) => process.stdout.write(text)) : null;
		// ssh's own messages ("Connection to ... closed by remote host").
		const err = whole ? wholeBlocks((text) => process.stderr.write(text)) : null;
		child.stdout?.setEncoding("utf8").on("data", (chunk) => out.push(chunk));
		child.stderr?.setEncoding("utf8").on("data", (chunk) => err.push(chunk));
		child.on("error", reject);
		child.on("close", (code, signal) => {
			out?.end();
			err?.end();
			resolvePromise(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1));
		});
	});
}

/** Hands text on to `write` a whole line at a time, and a `changed` step's lines (planScript's "== changed: NAME" up to
 * its "passed in" or "FAILED after", which ends the step's last line when that had no newline) in one write. `end`
 * hands on what is left. */
export function wholeBlocks(write) {
	let partial = "";
	let block = null;
	const line = (text) => {
		if (block) {
			block.text += text;
			if (block.end.test(text)) {
				write(block.text);
				block = null;
			}
			return;
		}
		const start = /^== changed: ([a-z0-9-]+)\n$/.exec(text);
		if (start) block = { text, end: new RegExp(`== changed: ${start[1]} (passed in|FAILED after) [0-9]+ s\\n$`) };
		else write(text);
	};
	return {
		push(chunk) {
			partial += chunk;
			for (let end = partial.indexOf("\n"); end >= 0; end = partial.indexOf("\n")) {
				line(partial.slice(0, end + 1));
				partial = partial.slice(end + 1);
			}
		},
		end() {
			const rest = `${block?.text ?? ""}${partial}`;
			block = null;
			partial = "";
			if (rest) write(rest);
		},
	};
}

/** A part's results that are no pass, the worst first: the harness's own (a machine died, a session was cut or a queue
 * timed out; no result read back), then npm ci or the build, then a failed step. A result not named here is worst. */
const WORST_FIRST = ["setup-failed", "unknown", "install-failed", "failed"];

/** The record of a changed --parts run from its parts' records (`records`, in part order): `run` names every part's run,
 * `machine` every part's machine (node02+node01). The run passes only if every part passed. Otherwise the part that
 * went worst (`WORST_FIRST`, the first such part on a tie) gives the run its result and its exit code (1 for an exit of
 * 0), whatever the order of the parts, so a failure one part ran never stands for a part that ran no steps, and a
 * machine that died posts the harness's error. A failed run's failed steps are every part's, in plan order (`order`),
 * and so are the steps --fail-fast stopped; none when a failed part names neither, as a single run cut off mid-way shows. */
export function joinRecords(records, { order, ...common }) {
	const notPassed = records.filter((record) => record.result !== "passed");
	const rank = (record) => WORST_FIRST.indexOf(record.result);
	const worst = notPassed.reduce((found, record) => (found && rank(found) <= rank(record) ? found : record), null);
	const result = worst ? worst.result : "passed";
	const every = (key) => [...new Set(records.flatMap((record) => record[key] ?? []))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
	const failedSteps = every("failedSteps");
	const stoppedSteps = every("stoppedSteps");
	const named = result === "failed" && notPassed.every((record) => record.failedSteps?.length || record.stoppedSteps?.length);
	return {
		schema: "qorpera.run-on-node/v1",
		machine: records.map((record) => record.machine).join("+"),
		run: records.map((record) => record.run).join("+"),
		runner: records.some((record) => record.runner) ? records.map((record) => record.runner ?? "none").join("+") : null,
		...common,
		exitCode: worst ? worst.exitCode || 1 : 0,
		result,
		...(named ? { failedSteps } : {}),
		...(named && stoppedSteps.length ? { stoppedSteps } : {}),
		parts: records,
	};
}

/** A child that a signal ended: by the signal itself, or ssh's own exit after one ("Killed by signal N."). */
function endedBySignal(result) {
	return Boolean(result.signal) || /Killed by signal/.test(String(result.stderr ?? ""));
}

function sshCapture(t, remoteScript) {
	const result = spawnSync("ssh", [...t.ssh, t.host, "bash", "-c", shellQuote(remoteScript)], { encoding: "utf8" });
	if (result.status !== 0)
		throw Object.assign(new Error(`Test machine unreachable or refused: ${(result.stderr || "").trim()}`), {
			final: endedBySignal(result),
		});
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
	const machines = candidateMachines(options.machine, process.env);
	const key = process.env.QORPERA_TEST_MACHINE_KEY || join(homedir(), ".ssh", "id_ed25519_qorpera_testvm");
	const { files, untracked } = workingTreeFiles(root);
	const secrets = secretLooking(untracked);
	if (secrets.length && !options.allowSecrets)
		throw new Error(`Untracked files that look like secrets would be copied (use --allow-secrets): ${secrets.join(", ")}`);
	const source = {
		head: git(root, ["rev-parse", "HEAD"]).toString().trim(),
		dirty: git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length > 0,
		files: files.length,
		untracked: untracked.length,
		treeSha256: treeDigest(root, files),
	};
	const github = githubStatus(root, options, source);
	let changedPlan = null;
	let plan = null;
	// --build or --no-build, which holds for every part of a --parts run too.
	const build = options.build;
	const stepWorkers = !options.env.some(([name]) => name === "VITEST_MAX_WORKERS");
	if (options.suite === "changed") {
		const { mergeBase, files: changed } = changedFiles(root, options.base, untracked);
		plan = planChanged(changed);
		for (const line of describePlan(plan, `${options.base} ${mergeBase.slice(0, 9)}, ${changed.length} files`)) console.log(line);
		changedPlan = { base: options.base, mergeBase, files: changed.length, full: plan.full, steps: plan.steps.map((step) => step.name) };
		if (!plan.steps.length) {
			// Documentation only is a result; no changed file at all (a commit master already contains) is not.
			if (changed.length) github.post("success", "nothing to run: documentation only");
			else console.error("== run-on-node: no change against master: nothing posted (run the test suite to check this commit)");
			return 0;
		}
		options.command = ["bash", "-c", planScript(plan.steps, { cores: options.cores, stepWorkers, failFast: options.failFast })];
		options.build = options.build ?? plan.build;
		if (options.build && !options.install) throw new Error("--build needs --install");
	}
	// The base copy unchanged files are taken from on the machine: one per checkout, so a run copies only what
	// changed since its checkout's last run. A checkout made fresh for each run (pr-loop's merged trees, a new
	// path every time) would find none and send all ~70 MB, 4-6 minutes per run on 14 Oct; --tree names a
	// shared one instead.
	const tree = options.tree ? `named-${options.tree}` : createHash("sha256").update(`${hostname()}:${root}`).digest("hex").slice(0, 16);
	const run = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-${process.pid}-${randomBytes(4).toString("hex")}`;
	const runDir = `${HOME}/runs/${run}`;
	const treeDir = `${HOME}/trees/${tree}`;
	const runCommand = runCommandLine(options);
	if (!options.dryRun && !existsSync(key)) throw new Error(`Missing test machine key ${key}`);
	// Before any machine is tried: a name rsync cannot copy is this tree's fault, not a machine's.
	const rulesText = `${includeRules(files).join("\n")}\n+ */\n- *\n`;
	// Every probe is read-only, so a dry run asks too and shows where the run would go. A run that names its
	// machine (--machine, QORPERA_TEST_MACHINE*) goes there even when it is closed.
	const probeStarted = Date.now();
	const probes = await probeAll(machines, (machine, signal) => probeOverSsh(machine, key, signal), {
		graceMs: PROBE_GRACE_MS,
		timeoutMs: PROBE_TIMEOUT_MS,
		quick: options.quick,
		front: options.front,
	});
	const probeSeconds = (Date.now() - probeStarted) / 1000;
	const ranked = runOrder(probes, Boolean(options.machine) || customTarget(process.env), options.quick, options.front).map((name) => {
		const machine = machines.find((candidate) => candidate.name === name);
		return { ...machine, ssh: sshArgs(machine, key) };
	});
	// changed --parts: the plan's steps split by their CPU work, each part a run of its own (RUN-p1, RUN-p2) with a plan
	// of its own, which tries the machines from its own on: part 1 the best-ranked one, part 2 the next.
	const split = plan && options.parts > 1 && ranked.length > 1 ? splitPlan(plan.steps, Math.min(options.parts, ranked.length)) : [];
	const parts = (
		split.length > 1
			? split.map((group, k) => ({
					run: `${run}-p${k + 1}`,
					order: [...ranked.slice(k), ...ranked.slice(0, k)],
					command: ["bash", "-c", planScript(group.steps, { cores: options.cores, stepWorkers, failFast: options.failFast })],
					build: build ?? group.build,
					changed: { ...changedPlan, steps: group.steps.map((step) => step.name) },
				}))
			: [{ run, order: ranked, command: options.command, build: options.build, changed: changedPlan }]
	).map((part) => ({ ...part, runDir: `${HOME}/runs/${part.run}`, runCommand: runCommandLine({ ...options, command: part.command }), passedOver: [] }));
	if (options.dryRun) {
		console.log(
			JSON.stringify(
				{
					machine: ranked[0]?.name ?? null,
					target: ranked[0]?.host ?? null,
					via: ranked[0]?.jump || null,
					machines: probes,
					probeSeconds,
					runDir,
					treeDir,
					install: options.install,
					runCommand,
					...(parts.length > 1
						? { parts: parts.map((part) => ({ machine: part.order[0].name, run: part.run, steps: part.changed.steps, build: part.build })) }
						: {}),
					source,
					githubStatus: github.plan,
				},
				null,
				2,
			),
		);
		return 0;
	}
	if (untracked.length) console.error(`== run-on-node: copying ${untracked.length} untracked file(s) too`);
	console.error(`== run-on-node: ${describeProbes(probes)}`);
	const pending = (machines) =>
		`running on ${machines.map((machine) => machineLabel(machine.name)).join(" + ")} (waits while ${CPU_SLOTS} runs are busy)`;

	try {
		if (!ranked.length) throw new Error(`No open test machine: ${describeProbes(probes)}`);
		if (parts.length > 1)
			console.error(
				`== run-on-node: in ${parts.length} parts at once: ${parts.map((part, k) => `part ${k + 1} on ${part.order[0].name}: ${part.changed.steps.join(", ")}`).join("; ")}`,
			);
		else if (options.parts > 1) console.error(`== run-on-node: in one part: ${ranked.length > 1 ? "the plan has one step" : "one machine to run on"}`);
		github.post("pending", pending(parts.map((part) => part.order[0])));
		return await execute();
	} catch (error) {
		github.post("error", `harness error: ${String(error.message).slice(0, 110)}`);
		throw error;
	}

	/** Prune, make the part's run directory, mark it as arriving and copy the tree to one machine; throws when the
	 * machine refuses, with `final` when a signal ended the copy. */
	function copyTree(part, t) {
		part.copyStarted = Date.now();
		sshCapture(t, `mkdir -p ${ARRIVING} && touch ${ARRIVING}/${part.run}\n${pruneScript()}\nmkdir -p ${part.runDir} ${treeDir}\ntouch ${treeDir}.lock`);
		part.pruned = Date.now();
		const rulesDir = mkdtempSync(join(tmpdir(), "run-on-node-"));
		const rules = join(rulesDir, "rules");
		writeFileSync(rules, rulesText);
		const rsync = spawnSync(
			"rsync",
			[
				"-a",
				"--prune-empty-dirs",
				`--filter=merge ${rules}`,
				...baseCopyCompare(Boolean(options.tree)),
				`--copy-dest=${treeDir}/`,
				// The base copy is read under a shared lock; its refresh below takes the exclusive one.
				`--rsync-path=flock -s ${treeDir}.lock rsync`,
				"-e",
				["ssh", ...t.ssh].map(shellQuote).join(" "),
				`${root}/`,
				`${t.host}:${part.runDir}/`,
			],
			{ stdio: ["ignore", "inherit", "inherit"] },
		);
		rmSync(rulesDir, { recursive: true, force: true });
		if (rsync.status !== 0) {
			try {
				sshCapture(t, `rm -f ${ARRIVING}/${part.run}`);
			} catch {
				// Ages out of the probe's count in 10 minutes.
			}
			// A signal (or rsync's exit 20 for one) ends the run; files that vanished or could not be read during the
			// copy (23, 24) are this tree's problem and would fail on every machine.
			throw Object.assign(new Error(`Copying the working tree failed (rsync ${rsync.signal ?? `exit ${rsync.status}`})`), {
				final: Boolean(rsync.signal) || [20, 23, 24].includes(rsync.status),
			});
		}
	}

	async function execute() {
		const started = Date.now();
		// Every part is copied before any starts, so a part no machine takes ends the run before a suite starts.
		const copied = [];
		try {
			for (const [k, part] of parts.entries()) {
				part.t = await firstTaking(
					part.order,
					(t) => copyTree(part, t),
					(machine, error, next) => {
						part.passedOver.push(machine.name);
						console.error(
							`== run-on-node: ${parts.length > 1 ? `part ${k + 1}: ` : ""}${machine.name} failed before the suite started (${error.message}); trying ${next.name}`,
						);
						if (parts.length === 1) github.post("pending", pending([next]));
					},
				);
				part.synced = Date.now();
				copied.push(part);
			}
		} catch (error) {
			for (const part of copied) {
				try {
					sshCapture(part.t, `rm -f ${ARRIVING}/${part.run}; sudo -n rm -rf -- ${part.runDir}`);
				} catch {
					// Pruned after a day; the arriving mark ages out of the probe's count in 10 minutes.
				}
			}
			throw error;
		}
		// A signal that arrived during the synchronous copy ends the run here, before a suite starts.
		await signalTurn();
		// A shared worktree can change between the check and the copy: then the copy is not the commit.
		if (
			github.plan.posted &&
			(git(root, ["rev-parse", "HEAD"]).toString().trim() !== source.head ||
				git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length > 0)
		)
			github.abandon("the working tree changed while it was copied: this run is not the commit's");

		if (parts.length === 1) return finish(await runPart(parts[0], started));
		// Every part runs to its end whatever the others do, unless --fail-fast stops them (runPart). The run passes only
		// when every part passed: a part whose machine died or that was cut off makes the whole run fail (joinRecords).
		const outcomes = await Promise.allSettled(parts.map((part) => runPart(part, started)));
		const rejected = outcomes.find((outcome) => outcome.status === "rejected");
		if (rejected) throw rejected.reason;
		return finish(
			joinRecords(
				outcomes.map((outcome) => outcome.value),
				{
					order: changedPlan.steps,
					machines: probes,
					probeSeconds,
					source,
					lane: "cpu",
					...(options.front ? { front: true } : {}),
					...(options.cores ? { cores: options.cores } : {}),
					...(options.failFast ? { failFast: true } : {}),
					changed: changedPlan,
					startedAt: new Date(started).toISOString(),
					elapsedSeconds: (Date.now() - started) / 1000,
				},
			),
		);
	}

	/** The record's GitHub status, the record line and the --record file; the run's exit code. */
	function finish(record) {
		record.githubStatus = github.post(statusState(record.result), statusDescription(record));
		console.log(`== run-on-node record ${JSON.stringify(record)}`);
		if (options.record) {
			try {
				writeFileSync(resolve(options.record), `${JSON.stringify(record, null, 2)}\n`);
			} catch (error) {
				console.error(`run-on-node: could not write ${options.record}: ${error.message}`);
			}
		}
		return record.exitCode;
	}

	/** One part's session on the machine that took its copy, then its status, the machine's versions and the cleanup:
	 * the part's record. A part's output comes a step at a time when the run has more than one (sshRun `whole`). */
	async function runPart(part, started) {
		const { t } = part;
		const code = await sshRun(
			t,
			runScript({
				run: part.run,
				runDir: part.runDir,
				treeDir,
				shared: Boolean(options.tree),
				files: files.length,
				copySeconds: (part.synced - part.copyStarted) / 1000,
				install: options.install,
				build: part.build,
				runCommand: part.runCommand,
				quick: options.quick,
				front: options.front,
				cores: options.cores,
			}),
			parts.length > 1,
		);
		const finished = Date.now();
		part.ended = true;
		// --fail-fast: a part that did not pass stops the others still running; their steps end and no more start (planScript).
		if (options.failFast && code !== 0)
			for (const [k, other] of parts.entries()) {
				if (other.ended) continue;
				console.error(`== run-on-node: part ${parts.indexOf(part) + 1} failed: stopping part ${k + 1} (--fail-fast)`);
				try {
					// A part whose directory is gone has ended.
					sshCapture(other.t, `sudo -n touch ${other.runDir}/${STOP} 2>/dev/null || [ ! -d ${other.runDir} ]`);
				} catch (error) {
					console.error(`run-on-node: could not stop part ${k + 1}: ${error.message}`);
				}
			}
		let status = {};
		try {
			status = parseStatus(sshCapture(t, `cat ${part.runDir}/.run-on-node-status 2>/dev/null || true`));
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
				sshCapture(t, `sudo -n rm -rf -- ${part.runDir}`);
			} catch (error) {
				console.error(`run-on-node: cleanup of ${part.runDir} failed (pruned after a day): ${error.message}`);
			}
		}
		return {
			schema: "qorpera.run-on-node/v1",
			machine: t.name,
			host: t.host,
			via: t.jump || null,
			machines: probes,
			probeSeconds,
			...(part.passedOver.length ? { passedOver: part.passedOver } : {}),
			environment,
			source,
			command: part.command,
			sudo: options.sudo,
			install: options.install,
			build: part.build,
			run: options.keep ? part.runDir : part.run,
			runner: status.runner ?? null,
			lane: options.quick ? "quick" : "cpu",
			...(options.front ? { front: true } : {}),
			...(options.cores ? { cores: options.cores } : {}),
			...(options.failFast ? { failFast: true } : {}),
			cpuSlot: status.slot ? Number(status.slot) : null,
			queuedSeconds: status.queued_s ? Number(status.queued_s) : null,
			vitestMaxWorkers: Number(options.env.findLast(([name]) => name === "VITEST_MAX_WORKERS")?.[1] ?? status.workers ?? Number.NaN) || null,
			loadAtStart: status.load ? Number(status.load) : null,
			uncappedTestProcesses: status.uncapped ? Number(status.uncapped) : null,
			...(part.changed ? { changed: part.changed } : {}),
			startedAt: new Date(started).toISOString(),
			copySeconds: (part.synced - part.copyStarted) / 1000,
			// The copy's two parts: the ssh call that marks the run arriving, prunes old runs and makes the run directory;
			// then rsync.
			pruneSeconds: (part.pruned - part.copyStarted) / 1000,
			rsyncSeconds: (part.synced - part.pruned) / 1000,
			prepareSeconds: status.prepare_ms ? Number(status.prepare_ms) / 1000 : null,
			suiteSeconds: status.suite_ms ? Number(status.suite_ms) / 1000 : null,
			elapsedSeconds: (finished - started) / 1000,
			exitCode: code,
			result:
				status.installed === "1"
					? code === 0
						? "passed"
						: "failed"
					: status.installed === "0"
						? "install-failed"
						: code === 0 && !status.runner
							? "unknown"
							: "setup-failed",
			...(status.failed_steps ? { failedSteps: status.failed_steps.split(",").filter(Boolean) } : {}),
			...(status.stopped_steps ? { stoppedSteps: status.stopped_steps.split(",").filter(Boolean) } : {}),
		};
	}
}

/** Decides once whether this run's result belongs on the commit, then posts each state change. */
function githubStatus(root, options, source) {
	let slug = null;
	try {
		slug = repoSlug(git(root, ["remote", "get-url", "origin"]).toString());
	} catch {
		// No origin: nothing to post to.
	}
	const context = statusContext(options.suite);
	let decision = statusDecision({
		suite: options.suite,
		dirty: source.dirty,
		disabled: options.noStatus,
		slug,
		plain: options.plain,
		base: options.base,
	});
	// The status names one of the listed machines: a run pointed at another machine does not speak for the suite.
	if (decision.post && customTarget(process.env))
		decision = { post: false, reason: "QORPERA_TEST_MACHINE* points the run at another machine" };
	if (decision.post) {
		const pushed = commitPushed(slug, source.head);
		const onBranch = git(root, ["branch", "-r", "--contains", source.head]).toString().trim().length > 0;
		if (pushed.error) decision = { post: false, reason: `gh cannot reach GitHub (${pushed.error})` };
		else if (!pushed.ok || !onBranch) decision = { post: false, reason: `HEAD ${source.head.slice(0, 9)} is on no pushed branch: push it first` };
	}
	const plan = { context, sha: source.head, posted: decision.post, reason: decision.reason };
	if (!decision.post && !options.dryRun && options.suite) console.error(`== run-on-node: no GitHub status (${decision.reason})`);
	let abandoned = null;
	let pending = false;
	const send = (state, description) => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const posted = postStatus({ slug, sha: source.head, state, context, description });
			if (posted.ok) {
				console.error(`== run-on-node: ${context} ${state} on ${source.head.slice(0, 9)}: ${description}`);
				return true;
			}
			if (attempt) console.error(`run-on-node: could not post the GitHub status: ${posted.error}`);
		}
		return false;
	};
	// An interrupted client must not leave its commit pending for good.
	const interrupted = (signal, code) => () => {
		if (pending) send("error", `interrupted (${signal}) before a result`);
		process.exit(code);
	};
	return {
		plan,
		abandon(reason) {
			abandoned = reason;
			if (decision.post && !options.dryRun) send("error", reason.slice(0, 140));
		},
		post(state, description) {
			if (!decision.post || options.dryRun || abandoned) return { ...plan, ...(abandoned ? { posted: false, reason: abandoned } : {}) };
			const text = options.suite === "changed" ? `${description} vs master` : description;
			const ok = send(state, text.length > 140 ? `${text.slice(0, 139)}…` : text);
			if (state === "pending" && ok && !pending) {
				pending = true;
				process.once("SIGINT", interrupted("SIGINT", 130));
				process.once("SIGTERM", interrupted("SIGTERM", 143));
				process.once("SIGHUP", interrupted("SIGHUP", 129));
			} else if (state !== "pending") pending = false;
			return { ...plan, state, description: text, posted: ok };
		},
	};
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
