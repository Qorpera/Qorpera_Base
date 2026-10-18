// P3's driver, on the test machine (test/prove-coding-session-vm.sh runs it as root once the throwaway node is set up):
// the test database (p3-database.mjs) with a company whose member has a coding session, the node's executor
// (p3-executor.ts) started in the node as its service unit would start it, and the runtime's side of four turns (ten on
// the folder model's phase B):
//   turn 1 starts a command that keeps printing, and edits and commits in its workspace (the executor's clone of a
//     throwaway repository on the node's stand-in GitHub); the turn's end pushes the commit and opens a draft pull request
//     (on the folder model's phase A, which has no repositories yet, its commands start at /company instead; on phase B,
//     the node's code host for its company seeds the code area under /company/code, the workspace is the session's
//     worktree there, and after the push a code host job of the driver's own finds the commit in the code area);
//   turn 2, a follow-up in the same session, reads that command: it still runs and its output grew (Order 9), then stops
//     it and leaves another running;
// then the rest of Order 9 (p3-order9.mjs cuts each wait short in the database): the machine sleeps after 10 idle
// minutes and turn 3 says what stopped; after a quiet day the agent is asked about archiving; archiving stops the
// session's programs, and a new message reopens it (turn 4, which says what the archive stopped).
// Then C2 on phase B (p3-c2.mjs): turn 5 keeps its machine awake through 10 quiet minutes (cut short in the database),
// then leaves a command that reads the company folder after the turn (the file turn 1 committed in its worktree); the
// node's folder service is killed, and turn 6 runs on the same machine, restarted for the folder: it says the restart
// stopped that command, and nothing keeps what the command printed. Turn 7 reads a file the platform saved in a folder of
// its own (so no machine has a copy) and leaves a command running; the owner narrows that folder to the company's
// members, so turn 8's lease marks the machine for a new disk, and before turn 9 the executor stops it (the session's
// MACHINE_NEW_DISK event names the command) and rebuilds it from its image: turn 9 says so, finds only the company folder
// kept (its home is new, its worktree's head the same) and no longer reads the file, and the keeper keeps its attachment
// on the new boot; turn 10 no longer says so.
// The executor's control RPCs come here over its stdout and run on the database as service_role; the runtime's coding
// command gateway (packages/runtime/src/cloud-coding-command-http.ts, bundled as p3-gateway.mjs) reaches the
// executor's command service through the same pipe. Prints PASS lines, then SESSION PROVEN.
//
//   node deploy/coding-worker/test/p3-driver.mjs <project> <node VM> <coding image fingerprint> <package directory> <node facts JSON>
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import * as c2 from "./p3-c2.mjs";
import * as database from "./p3-database.mjs";
import * as order9 from "./p3-order9.mjs";
import { postgrestError } from "./p3-postgrest-errors.mjs";

const [project, vm, imageFingerprint, packageDirectory, facts] = process.argv.slice(2);
if (!facts) throw new Error("usage: p3-driver.mjs <project> <node VM> <image fingerprint> <package directory> <node facts JSON>");
const node = JSON.parse(facts);
const { createHttpCloudCodingCommandGateway } = await import(pathToFileURL(resolve(packageDirectory, "p3/p3-gateway.mjs")).href);
const manifest = JSON.parse(readFileSync(resolve(packageDirectory, "guest/manifest.json"), "utf8"));
const pin = (file) => {
	const artifact = manifest.artifacts.find((entry) => entry.file === file);
	if (!artifact) throw new Error(`the guest package has no ${file}`);
	return artifact.sha256;
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const started = performance.now();
const elapsed = () => `${Math.round((performance.now() - started) / 1000)} s`;
const pass = (text) => console.log(`PASS: ${text}`);
const note = (text) => console.error(`p3: ${text}`);
function fail(text) {
	console.error(`FAIL: ${text}`);
	throw new Error(text);
}
const lxc = (...args) => execFileSync("lxc", ["--project", project, ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
/** Writes a root-owned 0600 file into the node. */
function pushFile(path, content) {
	const directory = mkdtempSync(join(tmpdir(), "p3-"));
	try {
		writeFileSync(join(directory, "file"), content, { mode: 0o600 });
		lxc("file", "push", join(directory, "file"), `${vm}${path}`, "--uid", "0", "--gid", "0", "--mode", "0600");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

// --- The executor's configuration: what the node's installer would write ---------------------------------------------
const COMMAND_PORT = 8471;
const nasPolicy = {
	schema: "qorpera.coding-nas-policy/v1", mountPoint: "/mnt/qorpera-nas", source: "127.0.0.1:/srv/nas",
	serverAddress: "127.0.0.1", rootPath: "/mnt/qorpera-nas/coding",
};
const vmPolicy = {
	bootstrapSha256: sha256("p3 coding machine bootstrap"), cpus: 2, imageFingerprint, memoryBytes: 2 * 1024 ** 3,
	network: "qagent0", project: "default", providerId: "p3-coding", providerPolicySha256: sha256("p3 coding provider policy"),
	// 5f's image has a 16 GiB root.
	rootDiskBytes: 20 * 1024 ** 3, storagePool: "default",
};
const repository = { host: "github.com", owner: "qorpera-p3", name: "proof", baseBranch: "main" };
const machineIdSha256 = sha256(node.machineId);
const commandToken = randomBytes(32).toString("base64url");
const SLEEPER = "sleep 86400";
// The workspace's head (the clone), an edit, a commit, the new head.
const EDIT = "git rev-parse HEAD && printf 'P3 proof\\n' >P3-PROOF.md && git add P3-PROOF.md && " +
	"git -c user.name='P3 proof' -c user.email=p3@qorpera.invalid commit -q -m 'P3 proof: an edit' && git rev-parse HEAD";
// Each coding machine's journal on the NAS: its newest events, as the executor wrote them.
const JOURNALS =
	"for binding in $(find /mnt/qorpera-nas/coding -name binding.json); do dir=$(dirname \"$binding\"); echo \"== $dir\"; " +
	"for event in $(ls \"$dir\" | grep -E '^[0-9]{6}[.]json$' | tail -n 12); do echo \"$event $(head -c 400 \"$dir/$event\")\"; done; done";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The executor's SQL control calls and the folder service's core calls: the last 60 (begun, kind, name, outcome, time),
// those not answered yet, how many of each control call the executor has made, and each custody it was answered
// (machine, intent, granted or why not).
const calls = { recent: [], pending: new Set(), rpc: new Map(), custody: [] };

// Inside a coding machine, for diagnose(): its folder program's units and journal, the mounts, the programs.
const GUEST_LOOK = [
	"uptime",
	"systemctl list-units --all --no-pager --plain 'qorpera-*'",
	"journalctl --no-pager -o short-monotonic -n 100 -u 'qorpera-folder-*'",
	"findmnt -rn -o TARGET,FSTYPE,OPTIONS | grep -E 'fuse|company' || true",
	"ls -la /opt/qorpera-guest /opt/qorpera-folder 2>&1",
	"ls -la /dev/vsock /dev/fuse 2>&1",
	"journalctl --no-pager -o short-monotonic -p warning -n 40",
	"true",
].join("; echo ----; ");

// In the node, for diagnose(): whether the bridge's account, under the bridge's own sandbox, can ask LXD which
// machine has a CID (lxd.rs answers "unavailable" for any failure, and nothing logs it).
const BRIDGE_LOOK = [
	"stat -c '%U:%G %a' /var/snap/lxd/common/lxd/unix.socket",
	"id qorpera-folder-bridge",
	"systemctl show -p ActiveState -p MainPID -p NRestarts qorpera-folder-bridge",
	"grep -E '^(Uid|Gid|Groups)' /proc/$(systemctl show -p MainPID --value qorpera-folder-bridge)/status",
	"systemd-run --wait --pipe --quiet -p User=qorpera-folder-bridge -p Group=qorpera-folder-bridge -p SupplementaryGroups=lxd -p ProtectSystem=strict -p PrivateDevices=yes -p NoNewPrivileges=yes curl -sS --max-time 5 --unix-socket /var/snap/lxd/common/lxd/unix.socket 'http://lxd/1.0/instances?all-projects=true&recursion=1' 2>&1 | grep -oE '\"(name|project|status|volatile.vsock_id)\":\"[^\"]*\"|^curl.*' | head -n 40",
	"true",
].join("; echo ----; ");

// In each code host, for diagnose(): its jobs' folder mounts (one transient unit per job; the journal keeps them).
const CODE_HOST_LOOK = [
	"uptime",
	"journalctl --no-pager -o short-monotonic -n 150 -u qorpera-code-host-folder.service",
	"findmnt -rn -o TARGET,FSTYPE,OPTIONS | grep -E 'fuse|company' || true",
	"true",
].join("; echo ----; ");
// The core calls whose request and answer the log keeps (startPostgrest): the saves, git leases and read releases a
// boundary waits on, so a held boundary shows its refusal (reason and paths) even on a 200.
const CORE_LOGGED = /^qorpera_folder_(commit|git_publish|git_lease_take|git_lease_release|record_release)$/;

const db = await database.openDatabase();
let executor;
let stopping;
let postgrest;
try {
	const ids = await database.seed(db, { vmPolicy, nasPolicy, machineIdSha256, repository });
	pass(`the test database has a company whose member's coding session may run on the node (${elapsed()})`);
	const config = {
		schema: "qorpera.coding-executor-service/v7", owner: ids.owner, supabaseUrl: "https://p3.invalid",
		commandPort: COMMAND_PORT, peerCommandPort: COMMAND_PORT + 1, commandPeers: [], storagePolicy: nasPolicy, vmPolicy,
		guest: {
			commandHelperSha256: pin("cloud-coding-command-guest.mjs"), gitHelperSha256: pin("cloud-coding-git-guest.mjs"),
			watchdogHelperSha256: pin("cloud-coding-watchdog.mjs"), storageHelperSha256: pin("cloud-coding-storage-guest.mjs"),
			uid: 1500, gid: 1500, resourceProfile: { maxLogBytes: 64 * 1024 ** 2 },
		},
		repositories: [{ repository: ids.repository ?? repository, credential: "qorpera-coding-repository-p3" }],
		// The folder model (5g-6a): the guest agent and the folder program the node holds, which the executor pushes into
		// each machine; every session then takes the folder path. The control socket is the default one.
		...(node.folder ? { folder: node.folder } : {}),
		// Its repositories (5g-6b): the company's code host, made from the image the node imported into its default
		// project's store, with the limits the node inventory policy's `codeHosts` would give.
		...(node.codeHost ? {
			codeHost: { imageFingerprint: node.codeHost.imageFingerprint, storagePool: "default", cpus: 1, memoryBytes: 1024 ** 3,
				rootDiskBytes: 12 * 1024 ** 3, running: 1 },
		} : {}),
	};
	pushFile("/etc/qorpera/coding-executor.json", JSON.stringify(config));
	pushFile("/etc/qorpera/coding-command.key", commandToken);

	// --- The folder model (phase A): the node's folder service reaches its core here, before any session opens a view --
	if (node.folder) {
		postgrest = startPostgrest();
		await postgrest.ready;
		pass(`the node's folder service has its core: the test database, through the stand-in PostgREST (${elapsed()})`);
	}

	// --- The executor, as its unit runs it ------------------------------------------------------------------------------
	note(`the NAS in the executor's sandbox:\n${sandboxMounts()}`);
	executor = startExecutor();
	await executor.ready;
	pass(`the executor runs in the node as its service unit would run it (${elapsed()})`);
	if (node.folder) {
		for (let waited = 0; !executor.folderLines.start && waited < 10000; waited += 250) await new Promise((settle) => setTimeout(settle, 250));
		const start = executor.folderLines.start;
		const logged = start ? JSON.parse(start) : null;
		if (logged?.agentSha256 !== node.folder.agent.sha256 || logged?.programSha256 !== node.folder.program.sha256 ||
			(logged?.repositories ?? "none") !== (node.codeHost ? "code-host" : "none"))
			fail(`the executor did not start on the folder model with the node's agent and program: ${start}`);
		pass(`the executor starts on the folder model with both pins: ${start}`);
	}
	const refreshing = setInterval(() => void database.refreshNode(db, ids).catch((error) => note(`refresh: ${error.message}`)), 20000);

	try {
		// --- Turn 1: a command that keeps printing ------------------------------------------------------------------------
		const { workerId } = await database.dispatchCodingTask(db, ids, { instructions: "P3 proof: start a command that keeps printing." });
		const turn1 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 1, timeoutMs: 20 * 60000 });
		pass(`turn 1 runs: the executor prepared the workspace and attached the session (${elapsed()})`);
		const mounted = () => executor.folderLines.mounts.filter((line) => {
			const logged = JSON.parse(line);
			return logged.workerId === workerId && typeof logged.viewId === "string" && typeof logged.machineId === "string";
		});
		if (node.folder) {
			if (!mounted().length) fail(`turn 1 runs with no folder view mounted for ${workerId}`);
			pass(`turn 1's session has its folder view: ${mounted().join(" ")}`);
		}
		const gateway1 = gatewayFor(turn1);
		const command = "for i in $(seq 1 1800); do echo \"tick $i\"; sleep 1; done";
		const begun = await database.beginCommand(db, turn1, { operationKey: "p3-ticking", command, timeoutMs: null });
		const start = await gateway1.start(turn1.scope, begun.input, AbortSignal.timeout(60000));
		await begun.complete(start);
		if (start.state !== "running") fail(`turn 1's command is ${start.state}, not running: ${JSON.stringify(start)}`);
		await new Promise((settle) => setTimeout(settle, 5000));
		const first = await gateway1.read(turn1.scope, { commandId: begun.commandId, offset: 0, limit: 4096 }, AbortSignal.timeout(60000));
		if (first.state !== "running" || !/tick 1\n/.test(first.output)) fail(`turn 1 cannot read its command: ${JSON.stringify(first)}`);
		pass(`turn 1 started a command and reads it running (${first.log.totalBytes} bytes, ${elapsed()})`);
		// The folder model's phase A has no repositories (5g-6b brings them): commands start at /company and a finished
		// turn exports nothing, so the edit, commit and push are phase B's.
		let head = node.baseSha;
		if (node.folder && !node.codeHost) {
			const where = await runToEnd(turn1, gateway1, "p3-where", "pwd");
			if (where.state !== "succeeded" || where.output.trim() !== "/company") fail(`turn 1's commands do not start at /company: ${JSON.stringify(where)}`);
			pass(`turn 1's commands start in the company folder at /company (${elapsed()})`);
			await database.finishTurn(db, turn1, { operationKey: "p3-turn-1", summary: "Started a command that keeps printing.", headSha: head });
			await executor.turnSettled();
			pass(`turn 1 ended; the session stands by (${elapsed()})`);
		} else {
			// Phase B: the code host seeded the company's code area and added the session's worktree, on its own branch.
			if (node.codeHost) {
				const worktree = `/company/code/${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}/worktrees/${workerId}`;
				const where = await runToEnd(turn1, gateway1, "p3-where", "pwd && git branch --show-current");
				const [cwd, branch] = where.output.trim().split("\n");
				if (where.state !== "succeeded" || cwd !== worktree || branch !== `qorpera/coding/${workerId}`)
					fail(`turn 1's commands do not start in its worktree ${worktree}: ${JSON.stringify(where)}`);
				pass(`turn 1's commands start in its worktree in the company's code area, ${cwd}, on ${branch} (${elapsed()})`);
			}
			const edited = await runToEnd(turn1, gateway1, "p3-edit", EDIT);
			const [cloned, committed] = edited.output.trim().split("\n").slice(-2);
			if (edited.state !== "succeeded" || cloned !== node.baseSha || !/^[0-9a-f]{40}$/.test(committed ?? ""))
				fail(`turn 1's edit and commit in its workspace: ${JSON.stringify(edited)}`);
			head = committed;
			pass(`turn 1's workspace is ${node.codeHost ? "its worktree" : "the executor's clone"} of qorpera-p3/proof at ${cloned}; ` +
				`an edit is committed as ${head} (${elapsed()})`);
			await database.finishTurn(db, turn1, { operationKey: "p3-turn-1", summary: "Started a command that keeps printing; committed an edit.", headSha: head });
			await executor.turnSettled();
			let pushed = published(workerId);
			for (let waited = 0; (pushed.sha !== head || !pushed.pull) && waited < 60000; waited += 2000, pushed = published(workerId))
				await new Promise((settle) => setTimeout(settle, 2000));
			if (pushed.sha !== head || pushed.pull?.draft !== true || pushed.pull.head.sha !== head)
				fail(`turn 1's end did not push its commit and open a draft pull request: ${JSON.stringify(pushed)}`);
			pass(`turn 1 ended: the throwaway repository has its commit on ${pushed.branch}, and a draft pull request ` +
				`${pushed.pull.html_url}; the session stands by (${elapsed()})`);
			if (node.codeHost) {
				// The commit is the company's too: a code host job of its own (as a session's attach runs one) finds it in
				// the code area's repository, whose main is the base the area was seeded at.
				const area = await executor.inspect({ companyId: ids.profileId, environmentId: ids.environmentId, repository, commit: head });
				if (area.holds !== true || area.ready !== true || area.base !== node.baseSha)
					fail(`the company's code area does not hold turn 1's commit: ${JSON.stringify(area)}`);
				pass(`the company's code area holds turn 1's commit ${head}, its main at ${area.base}: ${JSON.stringify(area)} (${elapsed()})`);
			}
		}

		// --- Turn 2: the same session reads turn 1's command -------------------------------------------------------------
		await database.followUp(db, ids, { workerId, text: "P3 proof: read the command you started." });
		const turn2 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 2, timeoutMs: 20 * 60000 });
		pass(`turn 2 runs in the same session (${elapsed()})`);
		const gateway2 = gatewayFor(turn2);
		const second = await gateway2.read(turn2.scope, { commandId: begun.commandId, tail: true, limit: 4096 }, AbortSignal.timeout(60000));
		if (second.state !== "running") fail(`turn 1's command is ${second.state} in turn 2: ${JSON.stringify(second)}`);
		if (second.log.totalBytes <= first.log.totalBytes) fail(`turn 1's command printed nothing more by turn 2: ${JSON.stringify(second)}`);
		const ticks = [...second.output.matchAll(/tick (\d+)/g)].map((match) => Number(match[1]));
		pass(`turn 2 reads the command turn 1 started: still running, at tick ${ticks.at(-1)} (${second.log.totalBytes} bytes, ${elapsed()})`);
		const cancelled = await gateway2.cancel(turn2.scope, begun.commandId, AbortSignal.timeout(60000));
		pass(`turn 2 stops it (${cancelled.state})`);
		const sleeper2 = await startSleeper(turn2, gateway2, "p3-sleeper-2");
		await database.finishTurn(db, turn2, { operationKey: "p3-turn-2", summary: "Read and stopped the command from turn 1.", headSha: head });
		await executor.turnSettled();
		console.error(JSON.stringify(await database.describe(db, ids)));
		pass(`turn 2 ended, leaving \`${SLEEPER}\` running (${elapsed()})`);

		// --- Order 9: the machine sleeps after 10 idle minutes, and the next turn says what stopped ------------------------
		const machine = await order9.machineOf(db, workerId);
		await order9.awaitRunning(db, workerId, sleeper2.commandId, 60000);
		const idle2 = await order9.awaitIdle(db, workerId, machine);
		pass(`with only \`${SLEEPER}\` running, a keep 40 s after turn 2 finds the session and its machine idle: ${JSON.stringify(idle2)} (${elapsed()})`);
		await order9.idleTenMinutes(db, machine);
		const slept = await order9.awaitDetached(db, workerId, machine, "SLEEP", 5 * 60000);
		const state = guestState(machine);
		if (state !== "STOPPED" || !slept.suspendedAt) fail(`the machine sleeps but is ${state} (node demand suspended at ${slept.suspendedAt})`);
		if (!slept.event.body.stopped.some((stopped) => stopped.commandId === sleeper2.commandId))
			fail(`the machine's sleep does not name turn 2's command: ${JSON.stringify(slept.event)}`);
		pass(`10 idle minutes later (the wait cut short in the database) the machine sleeps: ${machine.name} is stopped, its node ` +
			`capacity suspended at ${slept.suspendedAt}, and the session says what stopped: ${JSON.stringify(slept.event.body)} (${elapsed()})`);
		await database.followUp(db, ids, { workerId, text: "P3 proof: what stopped while your machine slept?" });
		const turn3 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 3, timeoutMs: 20 * 60000 });
		const stopped3 = (await database.turnContext(db, turn3)).commands.stopped;
		if (!stopped3.some((stopped) => stopped.commandId === sleeper2.commandId && stopped.reason === "SLEEP"))
			fail(`turn 3's context does not say the sleep stopped turn 2's command: ${JSON.stringify(stopped3)}`);
		pass(`turn 3 wakes the machine (${guestState(machine)}), and its context says what stopped: ${JSON.stringify(stopped3)} (${elapsed()})`);
		const gateway3 = gatewayFor(turn3);
		const sleeper3 = await startSleeper(turn3, gateway3, "p3-sleeper-3");
		await database.finishTurn(db, turn3, { operationKey: "p3-turn-3", summary: "Read what the sleep stopped; left a command running.", headSha: head });
		await executor.turnSettled();
		pass(`turn 3 ended, leaving \`${SLEEPER}\` running (${elapsed()})`);

		// --- Order 9: after a quiet day the agent is asked about archiving --------------------------------------------------
		await order9.awaitRunning(db, workerId, sleeper3.commandId, 60000);
		const settled = await database.settleParent(db, ids, { workerId });
		note(`the parent run, as the runner leaves it once the agent read the reports: ${JSON.stringify(settled)}`);
		const idle3 = await order9.awaitIdle(db, workerId, machine);
		pass(`with only \`${SLEEPER}\` running, a keep 40 s after turn 3 finds the session idle: ${JSON.stringify(idle3)} (${elapsed()})`);
		const quiet = await order9.quietDay(db, workerId);
		note(`the check-ins drain: ${JSON.stringify(quiet.due)} ${JSON.stringify(quiet.steps)}`);
		if (quiet.asked?.askedDays !== 1 || !/manage_worker action archive/.test(quiet.asked.summary ?? "") || !/with 1 command still running/.test(quiet.asked.summary))
			fail(`a quiet day later the agent is not asked about archiving: ${JSON.stringify(quiet)}`);
		pass(`a quiet day later (the wait cut short in the database) the agent is asked about archiving: ${quiet.asked.occurrenceKey} ` +
			`(${quiet.asked.status}): ${JSON.stringify(quiet.asked.summary)} (${elapsed()})`);

		// --- Order 9: archiving stops the session's programs, and a new message reopens it ----------------------------------
		if ((await order9.archive(db, workerId)) !== true) fail("the agent's archive archived nothing");
		const archived = await order9.awaitDetached(db, workerId, machine, "ARCHIVED", 2 * 60000);
		if (!archived.event.body.stopped.some((stopped) => stopped.commandId === sleeper3.commandId))
			fail(`the archive does not name turn 3's command: ${JSON.stringify(archived.event)}`);
		const left = guestProcesses(machine, SLEEPER);
		if (left) fail(`the archived session's command still runs on its machine: ${left}`);
		pass(`archiving stops the session's programs: ${JSON.stringify(archived.event.body)}; no \`${SLEEPER}\` is left on ${machine.name} (${elapsed()})`);
		await database.followUp(db, ids, { workerId, text: "P3 proof: carry on after the archive." });
		const turn4 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 4, timeoutMs: 20 * 60000 });
		const reopened = await order9.event(db, workerId, "reopened");
		if (!reopened) fail("turn 4 runs, but the session has no Reopened event");
		const stopped4 = (await database.turnContext(db, turn4)).commands.stopped;
		if (!stopped4.some((stopped) => stopped.commandId === sleeper3.commandId && stopped.reason === "ARCHIVED"))
			fail(`turn 4's context does not say the archive stopped turn 3's command: ${JSON.stringify(stopped4)}`);
		pass(`a new message reopens it: ${JSON.stringify(reopened.body)}, turn 4 runs, and its context says what the archive stopped: ` +
			`${JSON.stringify(stopped4)} (${elapsed()})`);
		await database.finishTurn(db, turn4, { operationKey: "p3-turn-4", summary: "Read what the archive stopped.", headSha: head });
		await executor.turnSettled();
		console.error(JSON.stringify(await database.describe(db, ids)));
		pass(`turn 4 ended (${elapsed()})`);

		// Phase B only: the node's store has a file's bytes only once a machine saved them, as phase B's code area and the
		// P3-PROOF.md turn 1 committed in its worktree; the seed's files are in the core alone (a read of one on the node is
		// UNAVAILABLE), and they are all phase A has.
		if (node.codeHost) {
			// --- C2: a long turn whose guest stays quiet keeps its machine awake ----------------------------------------------
			await database.followUp(db, ids, { workerId, text: "P3 proof: think for a while, then leave a command reading your proof file." });
			const turn5 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 5, timeoutMs: 20 * 60000 });
			if ((await order9.machineOf(db, workerId)).machineId !== machine.machineId) fail("turn 5 runs on another machine");
			const quiet5 = await c2.awaitQuiet(db, workerId, machine, 5 * 60000);
			note(`turn 5's guest is quiet: ${JSON.stringify(quiet5)}`);
			await c2.quietElevenMinutes(db, machine);
			const before5 = await c2.standing(db, workerId, machine);
			const lines5 = executor.machineLines.length;
			const lists5 = calls.rpc.get("qorpera_list_coding_machines") ?? 0;
			// Two housekeeping passes (every 30 s) and about seven keeps (every 10 s); the list as they read it, every 15 s.
			const entries5 = [];
			for (let waited = 0; waited <= 75000; waited += 15000) {
				if (waited) await new Promise((settle) => setTimeout(settle, 15000));
				entries5.push(await c2.listed(db, ids.owner, machineIdSha256, machine));
			}
			const clocks5 = await c2.clocks(db, machine);
			// A clock moved back up proves nothing about the turn: say which, and never move it back again.
			const moved = [clocks5.lastUsedAgo < 600 && `last used ${clocks5.lastUsedAt}`, clocks5.busyAgo < 600 && `last busy ${clocks5.busyAt}`].filter(Boolean);
			if (moved.length) fail(`a clock moved during turn 5's quiet wait, so the wait proved nothing: ${moved.join(", ")} (${JSON.stringify(clocks5)})`);
			const due = entries5.filter((entry) => entry?.live !== true || entry.reserved !== true || entry.superseded !== false || entry.sleepDue !== false);
			if (due.length) fail(`the executor's list does not keep turn 5's machine awake: ${JSON.stringify(due)}`);
			const sleeps = executor.machineLines.slice(lines5).filter((line) => line.machineId === machine.machineId && line.step === "sleep");
			if (sleeps.length) fail(`the executor's housekeeping tried to sleep turn 5's machine: ${JSON.stringify(sleeps)}`);
			const lists = (calls.rpc.get("qorpera_list_coding_machines") ?? 0) - lists5;
			if (lists < 4) fail(`the executor's keeper and housekeeping read the list only ${lists} times in 75 s`);
			const awake5 = await c2.standing(db, workerId, machine);
			const slept5 = (await c2.eventsAfter(db, workerId, before5.lastEventId)).filter((event) => event.body?.reason === "SLEEP");
			if (guestState(machine) !== "RUNNING" || awake5.attachedMachineId !== machine.machineId || !awake5.attached || !awake5.demand ||
				awake5.suspendedAt || slept5.length)
				fail(`turn 5's machine did not stay awake: ${guestState(machine)} ${JSON.stringify(awake5)} ${JSON.stringify(slept5)}`);
			pass(`turn 5 stays awake with both idle clocks 11 minutes back: 75 s and ${lists} list reads later its entry is live, ` +
				`reserved and not due to sleep (${JSON.stringify(entries5.at(-1))}), the clocks did not move (${JSON.stringify(clocks5)}), ` +
				`no sleep was tried, and the machine is RUNNING with the session attached (${elapsed()})`);
			await c2.usedNow(db, machine);

			// --- C2: the folder service crashes while a command's read is unreleased ------------------------------------------
			// The command waits for the driver, then reads turn 1's P3-PROOF.md after the turn and prints a number only the
			// guest's shell works out, so neither the command nor anything the driver writes holds it; then it only waits.
			const gateway5 = gatewayFor(turn5);
			const proofFile = `/company/code/${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}/worktrees/${workerId}/P3-PROOF.md`;
			const nonce = randomBytes(4).readUInt32BE();
			const unsaved = `P3-UNSAVED-${nonce + 1}`;
			const reader = await database.beginCommand(db, turn5, {
				operationKey: "p3-unsaved", timeoutMs: null,
				command: `while [ ! -e /dev/shm/p3-go ]; do sleep 1; done; if cat ${proofFile} 2>/dev/shm/p3-read-error; then touch /dev/shm/p3-read; fi; ` +
					`echo P3-UNSAVED-$((${nonce} + 1)); exec sleep 86401`,
			});
			const readerStart = await gateway5.start(turn5.scope, reader.input, AbortSignal.timeout(60000));
			await reader.complete(readerStart);
			if (readerStart.state !== "running") fail(`turn 5's reading command is ${readerStart.state}, not running: ${JSON.stringify(readerStart)}`);
			await database.finishTurn(db, turn5, { operationKey: "p3-turn-5", summary: "Stayed awake; left a command reading P3-PROOF.md.", headSha: head });
			await executor.turnSettled();
			pass(`turn 5 ended, leaving a command that has read nothing yet (${elapsed()})`);
			guestRun(machine, "touch", "/dev/shm/p3-go");
			let waiting = guestProcesses(machine, "^sleep 86401$");
			for (let waited = 0; !waiting && waited < 60000; waited += 1000, waiting = guestProcesses(machine, "^sleep 86401$"))
				await new Promise((settle) => setTimeout(settle, 1000));
			if (!waiting) fail("turn 5's command did not get past its read within 60 s");
			if (!guestHas(machine, "/dev/shm/p3-read"))
				fail(`turn 5's command could not read P3-PROOF.md after the turn: ${guestRun(machine, "cat", "/dev/shm/p3-read-error").trim()}`);
			await order9.awaitRunning(db, workerId, reader.commandId, 60000);
			const boot5 = guestRun(machine, "cat", "/proc/sys/kernel/random/boot_id").trim();
			const service5 = folderService();
			if (!service5.MainPID || service5.MainPID === "0") fail(`the node's folder service is not running: ${JSON.stringify(service5)}`);
			const crash = await c2.standing(db, workerId, machine);
			lxc("exec", vm, "--", "touch", "/run/p3-c2-crash");
			lxc("exec", vm, "--", "systemctl", "kill", "--signal=SIGKILL", "qorpera-folder-service.service");
			for (let waited = 0; nodeHas(`/proc/${service5.MainPID}`) && waited < 10000; waited += 250) await new Promise((settle) => setTimeout(settle, 250));
			if (nodeHas(`/proc/${service5.MainPID}`)) fail(`the folder service's process ${service5.MainPID} outlived its SIGKILL`);
			if (nodeHas("/run/qorpera-folder-service/clean-stop.json")) fail("the folder service's crash left a clean-stop note");
			pass(`the command read P3-PROOF.md after turn 5 and printed what it read; then the node's folder service ` +
				`(${service5.MainPID}) is killed, leaving no clean-stop note (${elapsed()})`);

			await database.followUp(db, ids, { workerId, text: "P3 proof: carry on after the folder service crashed." });
			const turn6 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 6, timeoutMs: 20 * 60000 });
			if ((await order9.machineOf(db, workerId)).machineId !== machine.machineId) fail("turn 6 runs on another machine");
			// Whichever look found the view gone (a renewal, the next attach), the machine restarts before the turn's view opens.
			let restarts = await c2.restartsSince(db, machine, crash.now);
			for (let waited = 0; !restarts.some((row) => row.state === "restarted") && waited < 180000; waited += 2000) {
				await new Promise((settle) => setTimeout(settle, 2000));
				restarts = await c2.restartsSince(db, machine, crash.now);
			}
			if (!restarts.some((row) => row.state === "restarted")) fail(`the machine was not restarted for the folder after the crash: ${JSON.stringify(restarts)}`);
			const after6 = await c2.standing(db, workerId, machine);
			if (after6.folderRestartAt || after6.newDiskAt || after6.attachedMachineId !== machine.machineId || !after6.demand || after6.suspendedAt)
				fail(`after the restart turn 6's machine is not as it should be: ${JSON.stringify(after6)}`);
			const events6 = await c2.eventsAfter(db, workerId, crash.lastEventId);
			const restartEvent = events6.find((event) => event.body?.reason === "FOLDER_RESTART");
			if (!restartEvent?.body.stopped.some((stopped) => stopped.commandId === reader.commandId))
				fail(`the session's restart event does not name turn 5's command: ${JSON.stringify(events6)}`);
			if (events6.some((event) => event.body?.reason === "SLEEP")) fail(`the machine slept after the crash: ${JSON.stringify(events6)}`);
			const boot6 = guestRun(machine, "cat", "/proc/sys/kernel/random/boot_id").trim();
			if (boot6 === boot5 || guestState(machine) !== "RUNNING") fail(`turn 6's machine did not boot again: boot ${boot6}, ${guestState(machine)}`);
			const stopped6 = (await database.turnContext(db, turn6)).commands.stopped;
			if (!stopped6.some((stopped) => stopped.commandId === reader.commandId && stopped.reason === "FOLDER_RESTART"))
				fail(`turn 6's context does not say the restart stopped turn 5's command: ${JSON.stringify(stopped6)}`);
			pass(`turn 6 runs on the same machine, restarted for the folder (boot ${boot5} → ${boot6}): ${JSON.stringify(restarts)}; ` +
				`the session says what stopped: ${JSON.stringify(restartEvent.body)}, and so does turn 6's context (${elapsed()})`);
			const gateway6 = gatewayFor(turn6);
			const left6 = await gateway6.read(turn6.scope, { commandId: reader.commandId, offset: 0, limit: 4096 }, AbortSignal.timeout(60000));
			if (left6.state !== "machine_stopped" || (left6.output ?? "").includes(unsaved) || (left6.output ?? "").includes("P3 proof"))
				fail(`turn 6 reads what turn 5's command printed from its unreleased read: ${JSON.stringify(left6)}`);
			// A command's output is kept in its host record on the NAS (host-commands/<id>/output.log, once its reads are
			// released); SQL keeps only digests. Neither may hold it.
			const held = await c2.holding(db, unsaved);
			if (held?.holding?.length !== 0 || held.unread?.length !== 0) fail(`the core keeps what turn 5's command printed: ${JSON.stringify(held)}`);
			const records = lxc("exec", vm, "--", "find", `${nasPolicy.rootPath}/workers`, "-type", "d", "-name", reader.commandId.replaceAll("-", "")).trim();
			const kept = [nodeGrep(unsaved, nasPolicy.rootPath), records ? nodeGrep("P3 proof", ...records.split("\n")) : null].filter(Boolean);
			const recorded = records ? lxc("exec", vm, "--", "ls", "-la", ...records.split("\n")).trim() : "none";
			if (kept.length) fail(`the NAS keeps what turn 5's command printed: ${kept.join(" ")} (its host record: ${recorded})`);
			const dropped = lxc("exec", vm, "--", "find", `${nasPolicy.rootPath}/control`, "-name", "dropped-start-*.json", "-newer", "/run/p3-c2-crash").trim();
			if (!dropped) fail("the executor did not write down that the crashed boot's disk is not to be kept (no dropped-start mark)");
			const service6 = folderService();
			if (!service6.MainPID || service6.MainPID === "0" || service6.MainPID === service5.MainPID)
				fail(`the node's folder service did not come back: ${JSON.stringify(service6)}`);
			const read6 = await runToEnd(turn6, gateway6, "p3-read-6", `cat ${proofFile}`);
			if (read6.state !== "succeeded" || !read6.output.includes("P3 proof")) fail(`turn 6 cannot read P3-PROOF.md on the new boot: ${JSON.stringify(read6)}`);
			pass(`what turn 5's command printed is gone: turn 6 reads it ${left6.state} with nothing of it, no table in the core and no ` +
				`file on the NAS holds ${unsaved} (its host record: ${recorded.split("\n").join("; ")}), the crashed boot is marked dropped ` +
				`(${dropped.split("\n").join(" ")}), and the folder service is back (${JSON.stringify(service6)}), so turn 6 reads ` +
				`P3-PROOF.md again (${elapsed()})`);
			await database.finishTurn(db, turn6, { operationKey: "p3-turn-6", summary: "Carried on after the folder service crashed.", headSha: head });
			await executor.turnSettled();
			console.error(JSON.stringify(await database.describe(db, ids)));
			pass(`turn 6 ended (${elapsed()})`);

			// --- C2: a read the session's turn can no longer place gets its machine a new disk --------------------------------
			// The platform saves a text in a folder of its own: no machine saved it, so none has a copy, and turn 7's read of
			// it comes from the node's folder service, into the machine's read set at the turn's boundary. Its bytes go into
			// the node's store as the object gateway's put leaves them, and the save confirms them in SQL (a test-only
			// shortcut: a member's machine or the office would save it through the folder service and the gateway).
			const shared = "p3-shared/disk.md";
			const sharedFolder = shared.split("/")[0];
			const sharedText = `P3 shared disk ${randomBytes(16).toString("hex")}\n`;
			const sharedChunk = `{"sha256":"${sha256(sharedText)}","bytes":${Buffer.byteLength(sharedText)}}`;
			const sharedManifest = `{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"${sha256(sharedText)}","bytes":${Buffer.byteLength(sharedText)},` +
				`"mediaType":"text/markdown","executable":false,"chunks":[${sharedChunk}]}`;
			storeObject(ids.profileId, sharedText);
			storeObject(ids.profileId, sharedManifest);
			const saved = await database.shareFile(db, ids, { path: shared, text: sharedText });
			if (saved?.manifest !== sharedManifest || !UUID.test(saved.version ?? "")) fail(`the platform's save of ${shared}: ${JSON.stringify(saved)}`);
			pass(`the platform saves ${shared} in a folder of its own, its bytes in the node's store (version ${saved.version}, ${elapsed()})`);

			await database.followUp(db, ids, { workerId, text: "P3 proof: read the shared file, then leave a command running." });
			const turn7 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 7, timeoutMs: 20 * 60000 });
			if ((await order9.machineOf(db, workerId)).machineId !== machine.machineId) fail("turn 7 runs on another machine");
			const gateway7 = gatewayFor(turn7);
			const read7 = await runToEnd(turn7, gateway7, "p3-read-7", `cat /company/${shared}`);
			if (read7.state !== "succeeded" || !read7.output.includes(sharedText)) fail(`turn 7 cannot read ${shared}: ${JSON.stringify(read7)}`);
			// A file in the session's home, on the machine's own disk, which a restart keeps and a new disk does not.
			const home7 = await runToEnd(turn7, gateway7, "p3-home-7",
				'echo P3-HOME >"$HOME/p3-home-marker" && cat "$HOME/p3-home-marker" && echo "$HOME" && findmnt -no FSTYPE --target "$HOME"');
			const [marker7, home, homeDisk] = (home7.output ?? "").trim().split("\n").slice(-3);
			if (home7.state !== "succeeded" || marker7 !== "P3-HOME" || !home?.startsWith("/") || home.startsWith("/company") ||
				!homeDisk || homeDisk === "tmpfs" || homeDisk.startsWith("fuse"))
				fail(`turn 7 cannot leave a file in its home, on the machine's own disk: ${JSON.stringify(home7)}`);
			const identity7 = instanceIdentity(machine);
			const boot7 = guestRun(machine, "cat", "/proc/sys/kernel/random/boot_id").trim();
			const sleeper7 = await startSleeper(turn7, gateway7, "p3-sleeper-7");
			await database.finishTurn(db, turn7, { operationKey: "p3-turn-7", summary: "Read the shared file; left a command running.", headSha: head });
			await executor.turnSettled();
			await order9.awaitRunning(db, workerId, sleeper7.commandId, 60000);
			// The read is the machine's once the turn's boundary released it; with no record of it the narrowing proves nothing.
			let reads7 = await c2.readSet(db, machine, shared);
			for (let waited = 0; !reads7?.holds && waited < 60000; waited += 2000) {
				await new Promise((settle) => setTimeout(settle, 2000));
				reads7 = await c2.readSet(db, machine, shared);
			}
			if (!reads7?.holds) fail(`turn 7's boundary did not put its read of ${shared} in the machine's read set: ${JSON.stringify(reads7)}`);
			pass(`turn 7 reads ${shared} from the node's folder service, and its boundary puts the read in the machine's read set ` +
				`(${JSON.stringify(reads7)}); it left a file in its home, ${home} (${homeDisk}), and \`${SLEEPER}\` running (${elapsed()})`);
			const narrowed = await c2.standing(db, workerId, machine);
			if (narrowed.folderRestartAt || narrowed.newDiskAt) fail(`turn 7's machine is marked before the narrowing: ${JSON.stringify(narrowed)}`);
			const custody7 = calls.custody.length;
			const resource = await database.narrow(db, ids, { path: sharedFolder });
			pass(`the owner narrows ${sharedFolder} to the company's members: ${JSON.stringify(resource)} (${elapsed()})`);

			// Turn 8's view opens before its lease, on a machine not marked yet; the lease's take-in then finds turn 7's read
			// no longer readable and marks the machine. Turn 8 runs nothing: a command would be refused (MACHINE_NEW_DISK).
			await database.followUp(db, ids, { workerId, text: "P3 proof: carry on after the narrowing." });
			const turn8 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 8, timeoutMs: 20 * 60000 });
			if ((await order9.machineOf(db, workerId)).machineId !== machine.machineId) fail("turn 8 runs on another machine");
			const marking = async () => ({ standing: await c2.standing(db, workerId, machine), restarts: await c2.restartsSince(db, machine, narrowed.now) });
			const isMarked = ({ standing, restarts }) =>
				(standing.newDiskAt && standing.folderRestartAt) || restarts.some((row) => row.state === "new-disk" || row.state === "replaced");
			let marked8 = await marking();
			for (let waited = 0; !isMarked(marked8) && waited < 60000; waited += 2000) {
				await new Promise((settle) => setTimeout(settle, 2000));
				marked8 = await marking();
			}
			if (!isMarked(marked8)) fail(`turn 8's lease did not mark the machine for a new disk: the narrowing left the read readable (${JSON.stringify(marked8)})`);
			pass(`turn 8's lease finds turn 7's read no longer readable and marks the machine for a new disk: ${JSON.stringify(marked8)} (${elapsed()})`);
			await database.finishTurn(db, turn8, { operationKey: "p3-turn-8", summary: "Ran nothing on a machine marked for a new disk.", headSha: head });
			await executor.turnSettled();
			pass(`turn 8 ended, running nothing (${elapsed()})`);

			// Before turn 9 the executor stops the machine ('new-disk', which ends the session's attachment and the command
			// turn 7 left) and rebuilds it from its image ('replaced', which empties the read set), then starts it.
			const keepFrom9 = executor.keepLines.length;
			await database.followUp(db, ids, { workerId, text: "P3 proof: what happened to your machine?" });
			const turn9 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 9, timeoutMs: 20 * 60000 });
			if ((await order9.machineOf(db, workerId)).machineId !== machine.machineId) fail("turn 9 runs on another machine");
			let restarts9 = await c2.restartsSince(db, machine, narrowed.now);
			for (let waited = 0; !restarts9.some((row) => row.state === "replaced") && waited < 180000; waited += 2000) {
				await new Promise((settle) => setTimeout(settle, 2000));
				restarts9 = await c2.restartsSince(db, machine, narrowed.now);
			}
			const replaced = restarts9.find((row) => row.state === "replaced");
			if (!replaced) fail(`the machine was not rebuilt for turn 9: ${JSON.stringify(restarts9)}`);
			const between = await c2.inTurn(db, workerId, 8, replaced.recordedAt);
			if (!between?.inTurn) fail(`the rebuild's record is not between turns 8 and 9: ${JSON.stringify(replaced)} ${JSON.stringify(between)}`);
			const after9 = await c2.standing(db, workerId, machine);
			if (after9.folderRestartAt || after9.newDiskAt || after9.lastError || after9.attachedMachineId !== machine.machineId || !after9.attached ||
				!after9.demand || after9.suspendedAt)
				fail(`after the rebuild turn 9's machine is not as it should be: ${JSON.stringify(after9)}`);
			const reads9 = await c2.readSet(db, machine, shared);
			if (reads9?.pairs !== 0 || reads9.records !== 0) fail(`the rebuild left the machine's read set: ${JSON.stringify(reads9)}`);
			const events9 = await c2.eventsAfter(db, workerId, narrowed.lastEventId);
			const newDisk = events9.filter((event) => event.body?.reason === "MACHINE_NEW_DISK");
			if (newDisk.length !== 1 || !newDisk[0].body.stopped?.some((stopped) => stopped.commandId === sleeper7.commandId))
				fail(`the session does not have one MACHINE_NEW_DISK event naming turn 7's command: ${JSON.stringify(events9)}`);
			const context9 = await database.turnContext(db, turn9);
			if (context9.machine?.newDisk !== true ||
				!context9.commands.stopped.some((stopped) => stopped.commandId === sleeper7.commandId && stopped.reason === "MACHINE_NEW_DISK"))
				fail(`turn 9's context does not say the machine got a new disk, which stopped turn 7's command: ` +
					`${JSON.stringify({ machine: context9.machine, stopped: context9.commands.stopped })}`);
			// The records since the narrowing, read again now that turn 9 is attached (its machine started): SQL's, the
			// custody the executor was answered for the machine, and its journal on the NAS (c2.judgeNewDisk).
			const journal9 = journalOf(machine);
			const restartsNow = await c2.restartsSince(db, machine, narrowed.now);
			const rebuild9 = c2.judgeNewDisk({
				restarts: restartsNow,
				custody: calls.custody.slice(custody7).filter((entry) => entry.machineId === machine.machineId),
				journal: journal9,
			});
			if (rebuild9.failures.length) fail(`${rebuild9.failures.join("; ")} (journal ${journal9.directory})`);
			pass(`before turn 9 the executor stopped the machine for a new disk and rebuilt it from its image: ${JSON.stringify(restartsNow)} ` +
				`(the rebuild between turns 8 and 9: ${JSON.stringify(between)}); custody granted ${rebuild9.granted.join(" → ")}; ` +
				`the journal ran ${rebuild9.ran.join(" → ")} ` +
				`and its disk record is ${JSON.stringify(journal9.disk)}; the session says what stopped: ${JSON.stringify(newDisk[0].body)}, ` +
				`turn 9's context says ${JSON.stringify(context9.machine)}, the read set is empty (${JSON.stringify(reads9)}), and the ` +
				`machine is attached, marks clear, with no error (${JSON.stringify(after9)}) (${elapsed()})`);
			const gateway9 = gatewayFor(turn9);
			const look9 = await runToEnd(turn9, gateway9, "p3-home-9",
				'if [ -e "$HOME/p3-home-marker" ]; then echo P3-HOME-KEPT; else echo P3-HOME-GONE; fi; echo "$HOME"; git rev-parse HEAD');
			const [kept9, home9, head9] = (look9.output ?? "").trim().split("\n").slice(-3);
			if (look9.state !== "succeeded" || kept9 !== "P3-HOME-GONE" || home9 !== home || head9 !== head)
				fail(`turn 9 does not find only the company folder kept (a new home ${home}, its worktree at ${head}): ${JSON.stringify(look9)}`);
			const read9 = await runToEnd(turn9, gateway9, "p3-read-9", `cat /company/${shared}`);
			if (read9.state === "succeeded" || (read9.output ?? "").includes(sharedText)) fail(`turn 9 still reads ${shared} after the narrowing: ${JSON.stringify(read9)}`);
			const boot9 = guestRun(machine, "cat", "/proc/sys/kernel/random/boot_id").trim();
			if (boot9 === boot7 || guestState(machine) !== "RUNNING") fail(`turn 9's machine did not boot again: boot ${boot9}, ${guestState(machine)}`);
			// The instance after the rebuild, compared after turn 10, so one run shows both.
			const identity9 = instanceIdentity(machine);
			pass(`turn 9 finds only the company folder kept: its home ${home} is new, its worktree is at ${head}, and it no longer reads ` +
				`${shared} (${read9.state}); the machine booted again (boot ${boot7} → ${boot9}) (${elapsed()})`);
			// The keeper keeps turn 9's attachment on the new boot, read before turn 10's attach moves it again: a keep renewed
			// it (its first pass after the attach, within about 10 s plus the pass), and the executor logged no session error
			// for the machine after turn 9's view mounted (c2.judgeKeep).
			let attachment9 = await c2.attachment(db, workerId);
			for (let waited = 0; !(attachment9?.lease > 61) && waited < 45000; waited += 2000) {
				await new Promise((settle) => setTimeout(settle, 2000));
				attachment9 = await c2.attachment(db, workerId);
			}
			const keep9 = c2.judgeKeep({ lines: executor.keepLines.slice(keepFrom9), machineId: machine.machineId, attachment: attachment9 });
			if (keep9.failures.length) fail(keep9.failures.join("; "));
			pass(`the keeper renewed turn 9's attachment on the new boot (${JSON.stringify(attachment9)}), and the executor logged no ` +
				`session error for the machine after turn 9's view mounted; before it, during the rebuild: ${JSON.stringify(keep9.before)} (${elapsed()})`);
			await database.finishTurn(db, turn9, { operationKey: "p3-turn-9", summary: "Read that the machine got a new disk.", headSha: head });
			await executor.turnSettled();
			pass(`turn 9 ended (${elapsed()})`);

			// The next turn no longer says it (20260930515000: a rebuild since the previous turn began).
			await database.followUp(db, ids, { workerId, text: "P3 proof: carry on." });
			const turn10 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 10, timeoutMs: 20 * 60000 });
			if ((await order9.machineOf(db, workerId)).machineId !== machine.machineId) fail("turn 10 runs on another machine");
			const context10 = await database.turnContext(db, turn10);
			if (context10.machine?.newDisk !== false) fail(`turn 10's context still says the machine got a new disk: ${JSON.stringify(context10.machine)}`);
			pass(`turn 10's context no longer says it: ${JSON.stringify(context10.machine)} (${elapsed()})`);
			// LXD's rebuild gives the instance a new root disk from its image and keeps the instance itself.
			const differs = [
				(!identity7.uuid || !identity7.vsockId || !Object.keys(identity7.hwaddrs).length) && `LXD showed no full identity before the rebuild (${JSON.stringify(identity7)})`,
				identity9.baseImage !== imageFingerprint && `volatile.base_image is ${identity9.baseImage}, not the image ${imageFingerprint}`,
				identity9.uuid !== identity7.uuid && `volatile.uuid ${identity7.uuid} → ${identity9.uuid}`,
				identity9.vsockId !== identity7.vsockId && `volatile.vsock_id ${identity7.vsockId} → ${identity9.vsockId}`,
				JSON.stringify(identity9.hwaddrs) !== JSON.stringify(identity7.hwaddrs) && `MAC addresses ${JSON.stringify(identity7.hwaddrs)} → ${JSON.stringify(identity9.hwaddrs)}`,
			].filter(Boolean);
			if (differs.length) fail(`the rebuilt machine is not the same instance on a disk from its image: ${differs.join("; ")}`);
			pass(`the rebuilt machine is the same instance on a disk from its image: ${JSON.stringify(identity9)} (${elapsed()})`);
			await database.finishTurn(db, turn10, { operationKey: "p3-turn-10", summary: "Carried on after the new disk.", headSha: head });
			await executor.turnSettled();
			console.error(JSON.stringify(await database.describe(db, ids)));
			pass(`turn 10 ended (${elapsed()})`);
		}
		if (node.folder) pass(`the session's folder view mounts, worker and view: ${mounted().join(" ")}`);
	} finally {
		clearInterval(refreshing);
	}
	await executor.stop();
	if (postgrest) pass(`the folder service's calls on its core: ${postgrest.summary()}`);
	console.log("SESSION PROVEN");
} catch (error) {
	if (stopping) await stopping;
	console.error(`p3: ${error?.stack ?? error}`);
	await diagnose();
	process.exitCode = 1;
} finally {
	await executor?.stop().catch(() => undefined);
	postgrest?.stop();
	await db.close();
}

/** Starts a command that uses nothing and never ends on its own, which the turn leaves running. */
async function startSleeper(turn, gateway, operationKey) {
	const begun = await database.beginCommand(db, turn, { operationKey, command: SLEEPER, timeoutMs: null });
	const start = await gateway.start(turn.scope, begun.input, AbortSignal.timeout(60000));
	await begun.complete(start);
	if (start.state !== "running") fail(`turn ${turn.scope.turn}'s \`${SLEEPER}\` is ${start.state}, not running: ${JSON.stringify(start)}`);
	return begun;
}

/** Runs a command in the turn to its end (2 minutes at most): the gateway's last read of it. */
async function runToEnd(turn, gateway, operationKey, command) {
	const begun = await database.beginCommand(db, turn, { operationKey, command, timeoutMs: 120000 });
	const start = await gateway.start(turn.scope, begun.input, AbortSignal.timeout(60000));
	await begun.complete(start);
	if (!["running", "succeeded", "failed"].includes(start.state)) fail(`\`${command}\` is ${start.state}: ${JSON.stringify(start)}`);
	const read = () => gateway.read(turn.scope, { commandId: begun.commandId, offset: 0, limit: 4096 }, AbortSignal.timeout(60000));
	let result = await read();
	for (const deadline = Date.now() + 120000; result.state === "running" && Date.now() < deadline; result = await read())
		await new Promise((settle) => setTimeout(settle, 1000));
	return result;
}

/** The stand-in GitHub's branch for the session's worker, its head, and its pull request (or nulls). */
function published(workerId) {
	const branch = `qorpera/coding/${workerId}`;
	const read = (...args) => {
		try {
			return lxc("exec", vm, "--", ...args).trim();
		} catch {
			return null;
		}
	};
	const sha = read("git", "--git-dir", "/srv/p3-github/qorpera-p3/proof.git", "rev-parse", "--verify", "-q", `refs/heads/${branch}`);
	const pulls = JSON.parse(read("cat", "/srv/p3-github/qorpera-p3/proof.pulls.json") || "[]");
	const pull = pulls.find((entry) => entry.head.ref === branch) ?? null;
	return { branch, sha, pull: pull && { ...pull, head: { ...pull.head, sha } } };
}

/** The coding machine's state in the node (RUNNING, STOPPED). */
function guestState(machine) {
	return lxc("exec", vm, "--", "lxc", "--project", machine.project, "list", `^${machine.name}$`, "-f", "csv", "-c", "s").trim();
}

/** The processes on the coding machine whose command line has `text`, or null. */
function guestProcesses(machine, text) {
	try {
		return lxc("exec", vm, "--", "lxc", "--project", machine.project, "exec", machine.name, "--", "pgrep", "-af", text).trim() || null;
	} catch (error) {
		if (error.status === 1) return null;
		throw error;
	}
}

/** Runs a program as root on the coding machine: its output. */
function guestRun(machine, ...args) {
	return lxc("exec", vm, "--", "lxc", "--project", machine.project, "exec", machine.name, "--", ...args);
}

/** Whether `path` is on the coding machine. */
function guestHas(machine, path) {
	try {
		guestRun(machine, "test", "-e", path);
		return true;
	} catch (error) {
		if (error.status === 1) return false;
		throw error;
	}
}

/** Whether `path` is in the node. */
function nodeHas(path) {
	try {
		lxc("exec", vm, "--", "test", "-e", path);
		return true;
	} catch (error) {
		if (error.status === 1) return false;
		throw error;
	}
}

/** The files under `paths` in the node that hold `text`, or null. A file the executor renamed away mid-scan is not
 * an error. */
function nodeGrep(text, ...paths) {
	try {
		return lxc("exec", vm, "--", "timeout", "300", "grep", "-rlaF", "-e", text, "--", ...paths).trim() || null;
	} catch (error) {
		if (error.status === 1) return null;
		const errors = String(error.stderr ?? "").trim().split("\n");
		if (error.status === 2 && errors.every((line) => line.endsWith(": No such file or directory"))) return String(error.stdout ?? "").trim() || null;
		throw error;
	}
}

/** The node's folder service unit: its main process (0 when none) and how often systemd restarted it. */
function folderService() {
	const shown = lxc("exec", vm, "--", "systemctl", "show", "-p", "MainPID", "-p", "NRestarts", "-p", "ActiveState", "qorpera-folder-service.service");
	return Object.fromEntries(shown.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
}

/** Puts `bytes` in the node's object store for the profile, as the object gateway's put leaves them (the profile's
 * folder 0700, each object 0600, both the gateway's). A test-only shortcut for a save no machine made. */
function storeObject(profileId, bytes) {
	const sha = sha256(bytes);
	const folder = `/srv/p3-objects/store/${profileId}`;
	lxc("exec", vm, "--", "install", "-d", "-m", "0700", "-o", "qorpera-objects", "-g", "qorpera-objects", folder);
	pushFile(`/run/p3-object-${sha}`, bytes);
	try {
		lxc("exec", vm, "--", "install", "-m", "0600", "-o", "qorpera-objects", "-g", "qorpera-objects", `/run/p3-object-${sha}`, `${folder}/${sha}`);
	} finally {
		lxc("exec", vm, "--", "rm", "-f", `/run/p3-object-${sha}`);
	}
}

/** The coding machine's instance as LXD keeps it: its UUID, its vsock id, the image its disk came from, and each
 * network card's MAC. */
function instanceIdentity(machine) {
	const { config } = JSON.parse(lxc("exec", vm, "--", "lxc", "query", `/1.0/instances/${machine.name}?project=${machine.project}`));
	return {
		uuid: config["volatile.uuid"] ?? null, vsockId: config["volatile.vsock_id"] ?? null, baseImage: config["volatile.base_image"] ?? null,
		hwaddrs: Object.fromEntries(Object.entries(config).filter(([key]) => /^volatile\.[^.]+\.hwaddr$/.test(key)).sort()),
	};
}

/** The coding machine's journal on the NAS: its directory, its disk record (or null for the disk it was made with), and
 * its newest 30 events, oldest first, across its segments. */
function journalOf(machine) {
	const bindings = lxc("exec", vm, "--", "find", `${nasPolicy.rootPath}/control`, "-path", `*/${machine.machineId}/binding.json`).trim();
	if (!bindings || bindings.includes("\n")) fail(`the machine has no one journal on the NAS: ${JSON.stringify(bindings)}`);
	const directory = bindings.slice(0, -"/binding.json".length);
	const events = lxc("exec", vm, "--", "sh", "-c",
		'cd "$1" && for event in $( (ls | grep -E "^[0-9]{6}[.]json$"; for segment in $(ls -d segment-* 2>/dev/null); do ' +
		'ls "$segment" | grep -E "^[0-9]{6}[.]json$" | sed "s|^|$segment/|"; done) | tail -n 30); do cat "$event"; done', "sh", directory);
	return {
		directory,
		disk: nodeHas(`${directory}/disk.json`) ? JSON.parse(lxc("exec", vm, "--", "cat", `${directory}/disk.json`)) : null,
		events: events.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)),
	};
}

/** The runtime's gateway for one turn, through the executor's pipe. */
function gatewayFor(turn) {
	return createHttpCloudCodingCommandGateway({
		url: `http://127.0.0.1:${COMMAND_PORT}`, token: commandToken,
		binding: turn.binding, holder: () => turn.holder, allowLoopback: true,
		authorize: async () => {
			throw new Error("P3_DRIVER_DOES_NOT_AUTHORIZE");
		},
		fetch: (url, init) => executor.http(url, init),
	});
}

// The executor unit's sandbox: the production unit's, plus its NAS drop-in. ReadWritePaths names the NAS mount itself,
// not the service root under it: systemd binds a ReadWritePaths path onto itself, and a bind of the root would be a
// mount of its own, which the storage's mount check refuses (OFFICE_HOST_MOUNT_MISMATCH, master run 5).
function executorSandbox() {
	return [
		"User=qorpera-coding-executor", "Group=qorpera-coding-executor", "SupplementaryGroups=lxd",
		"RuntimeDirectory=qorpera-coding-host", "RuntimeDirectoryMode=0700", "RuntimeDirectoryPreserve=yes",
		"ReadWritePaths=/mnt/qorpera-nas",
		"LoadCredential=qorpera-coding-executor-config:/etc/qorpera/coding-executor.json",
		"LoadCredential=qorpera-coding-command:/etc/qorpera/coding-command.key",
		"LoadCredential=qorpera-coding-repository-p3:/etc/qorpera/coding-repository-p3.key",
		"KillMode=control-group", "TimeoutStopSec=75s", "NoNewPrivileges=yes", "PrivateTmp=yes", "PrivateDevices=yes",
		"ProtectSystem=strict", "ProtectHome=yes", "ProtectKernelTunables=no", "ProtectKernelModules=yes",
		"ProtectControlGroups=yes", "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK", "CapabilityBoundingSet=",
		"UMask=0077", "MemoryMax=2G", "TasksMax=512", "CPUQuota=200%", "LimitCORE=0",
		"Environment=NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/p3-proof-ca.crt",
	].flatMap((property) => ["--property", property]);
}

/** The NAS's mount lines as the executor's sandbox sees them. */
function sandboxMounts() {
	return lxc("exec", vm, "--", "systemd-run", "--quiet", "--pipe", "--wait", "--collect", "--unit=p3-sandbox-mounts",
		...executorSandbox(), "/usr/bin/grep", "qorpera-nas", "/proc/self/mountinfo").trim();
}

function startExecutor() {
	const child = spawn("lxc", ["--project", project, "exec", vm, "--force-noninteractive", "--", "systemd-run", "--quiet", "--pipe", "--wait", "--collect",
		"--unit=p3-coding-executor", ...executorSandbox(),
		"/usr/local/bin/node", "-e", 'import("/opt/p3/p3-executor.mjs")'], { stdio: ["pipe", "pipe", "pipe"] });
	const httpPending = new Map();
	const inspectPending = new Map();
	let nextHttp = 0;
	let readyResolve;
	let readyReject;
	const ready = new Promise((resolveReady, rejectReady) => {
		readyResolve = resolveReady;
		readyReject = rejectReady;
	});
	// Turns the executor settled, and turnSettled's waiters: whichever comes first waits for the other.
	const settledTurns = [];
	const turnWaiters = [];
	let exited = false;
	const exit = new Promise((settle) => child.on("close", (code) => {
		exited = true;
		readyReject(new Error(`the executor exited (${code}) before it was ready`));
		for (const pending of [...httpPending.values(), ...inspectPending.values()]) pending.reject(new Error("the executor exited"));
		settle(code);
	}));
	const send = (value) => {
		if (!exited) child.stdin.write(`${JSON.stringify(value)}\n`);
	};
	// The folder model's own lines: the executor's start (its two pins) and each view it mounts. And each step its
	// housekeeping logs for a machine (sleep, delete, release, archive).
	const folderLines = { start: null, mounts: [] };
	const machineLines = [];
	// And, in one order, each view it mounts and each session error its keeper logs (c2.judgeKeep).
	const keepLines = [];
	createInterface({ input: child.stderr }).on("line", (line) => {
		console.error(`executor: ${line}`);
		let logged;
		try {
			logged = JSON.parse(line);
		} catch {
			return;
		}
		if (logged?.event === "coding-folder-mount" || logged?.event === "coding-session-error") keepLines.push(logged);
		if (logged?.event === "coding-executor-folder") folderLines.start = line;
		else if (logged?.event === "coding-folder-mount") folderLines.mounts.push(line);
		else if (logged?.event === "coding-machine" || logged?.event === "coding-machine-error") machineLines.push(logged);
	});
	createInterface({ input: child.stdout }).on("line", (line) => {
		if (!line.startsWith("P3 ")) return void console.error(`executor stdout: ${line}`);
		const message = JSON.parse(line.slice(3));
		// The executor's control (production's, ../control.ts) asks as it would ask PostgREST, and is answered as the
		// folder service is: the status and body tell it a busy row and a refusal apart.
		if (message.t === "rest") {
			const name = message.path.split("?")[0].replace(/^\/rest\/v1\/rpc\//, "");
			void timed("rpc", name, restAnswer(message.method, message.path, message.body)).then((answer) => {
				if (answer.status !== 200) note(`rpc ${name} answered ${answer.status}: ${answer.body.slice(0, 300)}`);
				send({ t: "rest", id: message.id, status: answer.status, body: answer.body });
			});
		} else if (message.t === "http") {
			const pending = httpPending.get(message.id);
			httpPending.delete(message.id);
			if (message.status === 0) pending?.reject(new Error(`the command service is unreachable: ${message.error?.join(" <- ")}`));
			else {
				if (message.status !== 200) note(`command service answered ${message.status}: ${message.body.slice(0, 300)}`);
				pending?.resolve(new Response(message.body, { status: message.status, headers: { "content-type": "application/json" } }));
			}
		} else if (message.t === "inspect") {
			const pending = inspectPending.get(message.id);
			inspectPending.delete(message.id);
			if (message.ok) pending?.resolve(message.state);
			else pending?.reject(new Error(`the code host job failed: ${message.error?.join(" <- ")}`));
		} else if (message.t === "ready") readyResolve();
		else if (message.t === "exit") {
			note(`executor: ${line.slice(3)}`);
			readyReject(new Error(`the executor stopped: ${(message.causes ?? []).join(" <- ")}`));
		} else if (message.t === "turn") {
			note(`the executor's turn settled: ${JSON.stringify(message.status)}`);
			// No later step can pass after such a turn: end the run now, not at the deadline of what the driver waits for.
			if (["blocked", "failed", "recovery-required"].includes(message.status)) void stopRun(`the executor's turn settled ${message.status}`);
			const waiter = turnWaiters.shift();
			if (waiter) waiter(message.status);
			else settledTurns.push(message.status);
		} else note(`executor: ${line.slice(3)}`);
	});
	return {
		ready,
		folderLines,
		machineLines,
		keepLines,
		http(url, init) {
			const id = ++nextHttp;
			const path = new URL(url).pathname;
			return new Promise((resolveHttp, rejectHttp) => {
				httpPending.set(id, { resolve: resolveHttp, reject: rejectHttp });
				send({ t: "http", id, path, headers: init.headers, body: init.body });
			});
		},
		/** The company's code area for a repository, from a code host job the executor runs (p3-executor.ts's "inspect"). */
		inspect({ companyId, environmentId, repository, commit }) {
			const id = ++nextHttp;
			return new Promise((resolveInspect, rejectInspect) => {
				inspectPending.set(id, { resolve: resolveInspect, reject: rejectInspect });
				send({ t: "inspect", id, companyId, environmentId, repository, commit });
			});
		},
		turnSettled(timeoutMs = 10 * 60000) {
			if (settledTurns.length) return Promise.resolve(settledTurns.shift());
			return new Promise((resolveTurn, rejectTurn) => {
				const timer = setTimeout(() => rejectTurn(new Error("the executor's turn did not settle")), timeoutMs);
				turnWaiters.push((status) => {
					clearTimeout(timer);
					resolveTurn(status);
				});
			});
		},
		async stop() {
			if (exited) return;
			send({ t: "stop" });
			// The child's SIGTERM need not reach the unit (lxc exec, then systemd-run --wait; run 9 hung 15 min on an
			// executor that had said it exits): stop the unit itself too, and kill the child if even that does not end it.
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				try {
					lxc("exec", vm, "--", "systemctl", "stop", "p3-coding-executor");
				} catch (error) {
					note(`stopping p3-coding-executor failed: ${String(error.stderr ?? error.message).slice(0, 300)}`);
				}
			}, 120000);
			const killer = setTimeout(() => child.kill("SIGKILL"), 240000);
			await exit;
			clearTimeout(timer);
			clearTimeout(killer);
		},
	};
}

/** The stand-in PostgREST in the node (test/p3-postgrest.mjs): each request the folder service makes of its core runs
 * here on the test database, as PostgREST would run it on the service key. */
function startPostgrest() {
	const child = spawn("lxc", ["--project", project, "exec", vm, "--force-noninteractive", "--", "/usr/local/bin/node",
		"/root/push/coding-worker/test/p3-postgrest.mjs", "127.0.0.2", "/etc/p3-github/supabase.crt", "/etc/p3-github/supabase.key"],
		{ stdio: ["pipe", "pipe", "pipe"] });
	const calls = new Map();
	let readyResolve;
	let readyReject;
	const ready = new Promise((resolveReady, rejectReady) => {
		readyResolve = resolveReady;
		readyReject = rejectReady;
	});
	let exited = false;
	child.on("close", (code) => {
		exited = true;
		readyReject(new Error(`the stand-in PostgREST exited (${code}) before it was ready`));
	});
	createInterface({ input: child.stderr }).on("line", (line) => console.error(`postgrest: ${line}`));
	createInterface({ input: child.stdout }).on("line", (line) => {
		if (!line.startsWith("P3 ")) return void console.error(`postgrest stdout: ${line}`);
		const message = JSON.parse(line.slice(3));
		if (message.t === "ready") return readyResolve();
		if (message.t !== "rest") return note(`postgrest: ${line.slice(3)}`);
		void timed("core", `${message.method} ${message.path.split("?")[0]}`, restAnswer(message.method, message.path, message.body)).then((answer) => {
			const name = answer.name ?? `${message.method} ${message.path.split("?")[0]}`;
			const counted = calls.get(name) ?? { ok: 0, refused: 0 };
			counted[answer.status < 300 ? "ok" : "refused"] += 1;
			calls.set(name, counted);
			if (answer.status >= 300) note(`core ${name} answered ${answer.status}: ${answer.body.slice(0, 300)}`);
			else if (CORE_LOGGED.test(name))
				note(`core ${name} asked ${(message.body ?? "").slice(0, 600)} answered ${answer.status}: ${answer.body.slice(0, 1500)}`);
			if (!exited) child.stdin.write(`${JSON.stringify({ id: message.id, status: answer.status, body: answer.body })}\n`);
		});
	});
	return {
		ready,
		summary: () => [...calls].map(([name, { ok, refused }]) => `${name} ${ok}${refused ? ` (+${refused} refused)` : ""}`).join(", ") || "none",
		stop() {
			if (exited) return;
			child.stdin.end();
			setTimeout(() => exited || child.kill("SIGTERM"), 5000).unref();
		},
	};
}

/** One PostgREST request, of the node's folder service or the executor's control: an RPC, or the clocks the folder
 * service polls (core.ts `clocks`). Errors as PostgREST answers them (p3-postgrest-errors.mjs): its status, the
 * SQLSTATE as `code`, the message as raised. */
async function restAnswer(method, path, body) {
	const url = new URL(path, "https://p3-supabase.test");
	const rpc = /^\/rest\/v1\/rpc\/(qorpera_[a-z0-9_]{1,120})$/.exec(url.pathname);
	try {
		if (method === "POST" && rpc) {
			const args = body ? JSON.parse(body) : {};
			const answer = await database.rpc(db, rpc[1], args);
			if (rpc[1] === "qorpera_authorize_coding_machine_custody")
				calls.custody.push({ machineId: args.p_machine_id, intent: args.p_intent, answer: answer?.state === "refused" ? `refused ${answer.reason}` : "granted" });
			return { name: rpc[1], status: 200, body: JSON.stringify(answer) };
		}
		const ids = /^in\.\(([0-9a-f,-]*)\)$/.exec(url.searchParams.get("environment_id") ?? "")?.[1].split(",");
		if (method === "GET" && url.pathname === "/rest/v1/qorpera_folder_clocks" && url.searchParams.get("select") === "environment_id,last_seq" &&
			[...url.searchParams.keys()].length === 2 && ids?.every((id) => UUID.test(id))) {
			const marker = `@@clocks${randomBytes(6).toString("hex")}@@`;
			const [rows] = await db.marked(`begin;\nset local role service_role;\nselect ${database.quote(marker)} ||
				coalesce(jsonb_agg(jsonb_build_object('environment_id', environment_id, 'last_seq', last_seq)), '[]'::jsonb)::text
				from public.qorpera_folder_clocks where environment_id = any(${database.quote(`{${ids.join(",")}}`)}::uuid[]);\ncommit;`, marker);
			return { name: "clocks", status: 200, body: JSON.stringify(rows) };
		}
		return { status: 404, body: JSON.stringify({ code: "PGRST125", message: "Invalid path specified in request URL", details: null, hint: null }) };
	} catch (error) {
		return { name: rpc?.[1], ...postgrestError(error) };
	}
}

/** Times one call (calls): one that takes 5 s or more, or has no answer after 10 s, is noted at once. */
function timed(kind, name, answer) {
	const begun = performance.now();
	const call = `${elapsed()} ${kind} ${name}`;
	calls.pending.add(call);
	if (kind === "rpc") calls.rpc.set(name, (calls.rpc.get(name) ?? 0) + 1);
	const waiting = setTimeout(() => note(`${call}: no answer after 10 s`), 10000);
	waiting.unref();
	const done = (outcome) => {
		clearTimeout(waiting);
		calls.pending.delete(call);
		const ms = Math.round(performance.now() - begun);
		calls.recent.push(`${call} ${outcome} ${ms} ms`);
		if (calls.recent.length > 60) calls.recent.shift();
		if (ms >= 5000) note(`${call}: ${outcome} after ${ms} ms`);
	};
	return answer.then(
		(value) => {
			done("answered");
			return value;
		},
		(error) => {
			done("failed");
			throw error;
		},
	);
}

/** Ends a run that can no longer pass, at once: diagnoses it, stops the executor and exits. */
function stopRun(reason) {
	stopping ??= (async () => {
		try {
			console.error(`FAIL: ${reason} (${elapsed()})`);
			await diagnose();
		} finally {
			await executor?.stop().catch(() => undefined);
			await db.close().catch(() => undefined);
			process.exit(1);
		}
	})();
	return stopping;
}

/** What a failed run leaves to read: the node's machines, the stand-in GitHub's requests, the database's view. */
async function diagnose() {
	for (const [title, args] of [
		["the node's machines", ["exec", vm, "--", "lxc", "list", "--all-projects", "-f", "compact"]],
		["the stand-in GitHub's last requests", ["exec", vm, "--", "tail", "-n", "30", "/var/log/p3-github.log"]],
		["the node's NAS", ["exec", vm, "--", "find", "/mnt/qorpera-nas/coding", "-maxdepth", "4"]],
		["the coding machines' journals", ["exec", vm, "--", "bash", "-c", JOURNALS]],
		["LXD's operations", ["exec", vm, "--", "lxc", "operation", "list", "--all-projects", "-f", "compact"]],
		["LXD's warnings and errors", ["exec", vm, "--", "bash", "-c", "journalctl -u snap.lxd.daemon --no-pager -o cat | grep -E 'level=(warning|error)' | tail -n 30"]],
		...(node.folder ? [["the folder service's journal", ["exec", vm, "--", "journalctl", "-u", "qorpera-folder-service", "-u",
			"qorpera-folder-bridge", "-u", "p3-objects", "-n", "80", "--no-pager"]]] : []),
		...(node.folder ? [["the node's vsock sockets and modules", ["exec", vm, "--", "bash", "-c", "ss -a --vsock 2>&1 | head -n 30; lsmod | grep -E 'vsock|fuse' || true"]]] : []),
		...(node.folder ? [["the bridge's view of LXD", ["exec", vm, "--", "bash", "-c", BRIDGE_LOOK]]] : []),
	]) {
		try {
			console.error(`--- ${title}\n${lxc(...args)}`);
		} catch (error) {
			console.error(`--- ${title}: ${error.stderr ?? error.message}`);
		}
	}
	if (postgrest) console.error(`--- the folder service's calls on its core: ${postgrest.summary()}`);
	console.error(`--- the last control and core calls (begun, kind, name, outcome, time)\n${calls.recent.join("\n")}`);
	if (calls.pending.size) console.error(`--- calls with no answer: ${[...calls.pending].join(", ")}`);
	try {
		const machines = lxc("exec", vm, "--", "lxc", "list", "-c", "n", "-f", "csv").trim().split("\n").filter(Boolean);
		for (const machine of machines) {
			for (const [title, args] of [
				[`console of ${machine}`, ["timeout", "30", "lxc", "console", machine, "--show-log"]],
				[`inside ${machine}`, ["timeout", "90", "lxc", "exec", machine, "--", "bash", "-c", GUEST_LOOK]],
			]) {
				try {
					console.error(`--- ${title}\n${lxc("exec", vm, "--", ...args).split("\n").slice(-150).join("\n")}`);
				} catch (error) {
					console.error(`--- ${title}: ${error.stderr ?? error.message}`);
				}
			}
		}
	} catch (error) {
		console.error(`--- the node's machines: ${error.stderr ?? error.message}`);
	}
	if (node.codeHost) {
		try {
			const hosts = JSON.parse(lxc("exec", vm, "--", "lxc", "list", "--all-projects", "-f", "json"))
				.filter(instance => /^qorpera-codehost-[0-9a-f]{32}$/.test(instance.project));
			for (const host of hosts) {
				try {
					const look = lxc("exec", vm, "--", "timeout", "90", "lxc", "exec", "--project", host.project, host.name, "--", "bash", "-c", CODE_HOST_LOOK);
					console.error(`--- inside ${host.project}/${host.name}\n${look.split("\n").slice(-180).join("\n")}`);
				} catch (error) {
					console.error(`--- inside ${host.project}/${host.name}: ${error.stderr ?? error.message}`);
				}
			}
		} catch (error) {
			console.error(`--- the node's code hosts: ${error.stderr ?? error.message}`);
		}
	}
	try {
		console.error(`--- the database\n${JSON.stringify(await database.describe(db), null, 1)}`);
	} catch (error) {
		console.error(`--- the database: ${error.message}`);
	}
}
