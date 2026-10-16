// P3's driver, on the test machine (test/prove-coding-session-vm.sh runs it as root once the throwaway node is set up):
// the test database (p3-database.mjs) with a company whose member has a coding session, the node's executor
// (p3-executor.ts) started in the node as its service unit would start it, and the runtime's side of four turns:
//   turn 1 starts a command that keeps printing, and edits and commits in its workspace (the executor's clone of a
//     throwaway repository on the node's stand-in GitHub); the turn's end pushes the commit and opens a draft pull request;
//   turn 2, a follow-up in the same session, reads that command: it still runs and its output grew (Order 9), then stops
//     it and leaves another running;
// then the rest of Order 9 (p3-order9.mjs cuts each wait short in the database): the machine sleeps after 10 idle
// minutes and turn 3 says what stopped; after a quiet day the agent is asked about archiving; archiving stops the
// session's programs, and a new message reopens it (turn 4, which says what the archive stopped).
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
import * as database from "./p3-database.mjs";
import * as order9 from "./p3-order9.mjs";

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
	rootDiskBytes: 12 * 1024 ** 3, storagePool: "default",
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

const db = await database.openDatabase();
let executor;
let stopping;
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
	};
	pushFile("/etc/qorpera/coding-executor.json", JSON.stringify(config));
	pushFile("/etc/qorpera/coding-command.key", commandToken);

	// --- The executor, as its unit runs it ------------------------------------------------------------------------------
	note(`the NAS in the executor's sandbox:\n${sandboxMounts()}`);
	executor = startExecutor();
	await executor.ready;
	pass(`the executor runs in the node as its service unit would run it (${elapsed()})`);
	const refreshing = setInterval(() => void database.refreshNode(db, ids).catch((error) => note(`refresh: ${error.message}`)), 20000);

	try {
		// --- Turn 1: a command that keeps printing ------------------------------------------------------------------------
		const { workerId } = await database.dispatchCodingTask(db, ids, { instructions: "P3 proof: start a command that keeps printing." });
		const turn1 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 1, timeoutMs: 20 * 60000 });
		pass(`turn 1 runs: the executor prepared the workspace and attached the session (${elapsed()})`);
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
		const edited = await runToEnd(turn1, gateway1, "p3-edit", EDIT);
		const [cloned, head] = edited.output.trim().split("\n").slice(-2);
		if (edited.state !== "succeeded" || cloned !== node.baseSha || !/^[0-9a-f]{40}$/.test(head ?? ""))
			fail(`turn 1's edit and commit in its workspace: ${JSON.stringify(edited)}`);
		pass(`turn 1's workspace is the executor's clone of qorpera-p3/proof at ${cloned}; an edit is committed as ${head} (${elapsed()})`);
		await database.finishTurn(db, turn1, { operationKey: "p3-turn-1", summary: "Started a command that keeps printing; committed an edit.", headSha: head });
		await executor.turnSettled();
		let pushed = published(workerId);
		for (let waited = 0; (pushed.sha !== head || !pushed.pull) && waited < 60000; waited += 2000, pushed = published(workerId))
			await new Promise((settle) => setTimeout(settle, 2000));
		if (pushed.sha !== head || pushed.pull?.draft !== true || pushed.pull.head.sha !== head)
			fail(`turn 1's end did not push its commit and open a draft pull request: ${JSON.stringify(pushed)}`);
		pass(`turn 1 ended: the throwaway repository has its commit on ${pushed.branch}, and a draft pull request ` +
			`${pushed.pull.html_url}; the session stands by (${elapsed()})`);

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
	} finally {
		clearInterval(refreshing);
	}
	await executor.stop();
	console.log("SESSION PROVEN");
} catch (error) {
	if (stopping) await stopping;
	console.error(`p3: ${error?.stack ?? error}`);
	await diagnose();
	process.exitCode = 1;
} finally {
	await executor?.stop().catch(() => undefined);
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
		for (const pending of httpPending.values()) pending.reject(new Error("the executor exited"));
		settle(code);
	}));
	const send = (value) => {
		if (!exited) child.stdin.write(`${JSON.stringify(value)}\n`);
	};
	createInterface({ input: child.stderr }).on("line", (line) => console.error(`executor: ${line}`));
	createInterface({ input: child.stdout }).on("line", (line) => {
		if (!line.startsWith("P3 ")) return void console.error(`executor stdout: ${line}`);
		const message = JSON.parse(line.slice(3));
		if (message.t === "rpc")
			void database.rpc(db, message.method, message.args).then(
				(result) => send({ t: "rpc", id: message.id, ok: true, result }),
				(error) => {
					note(`rpc ${message.method} failed: ${error.sqlState ?? "-"} ${String(error.message).slice(0, 300)}`);
					send({ t: "rpc", id: message.id, ok: false, sqlState: error.sqlState ?? null });
				},
			);
		else if (message.t === "http") {
			const pending = httpPending.get(message.id);
			httpPending.delete(message.id);
			if (message.status === 0) pending?.reject(new Error(`the command service is unreachable: ${message.error?.join(" <- ")}`));
			else {
				if (message.status !== 200) note(`command service answered ${message.status}: ${message.body.slice(0, 300)}`);
				pending?.resolve(new Response(message.body, { status: message.status, headers: { "content-type": "application/json" } }));
			}
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
		http(url, init) {
			const id = ++nextHttp;
			const path = new URL(url).pathname;
			return new Promise((resolveHttp, rejectHttp) => {
				httpPending.set(id, { resolve: resolveHttp, reject: rejectHttp });
				send({ t: "http", id, path, headers: init.headers, body: init.body });
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
			const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
			await exit;
			clearTimeout(timer);
		},
	};
}

/** Ends a run that can no longer pass, at once: diagnoses it, stops the executor and exits. */
function stopRun(reason) {
	stopping ??= (async () => {
		try {
			console.error(`FAIL: ${reason}`);
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
	]) {
		try {
			console.error(`--- ${title}\n${lxc(...args)}`);
		} catch (error) {
			console.error(`--- ${title}: ${error.stderr ?? error.message}`);
		}
	}
	try {
		const machines = lxc("exec", vm, "--", "lxc", "list", "-c", "n", "-f", "csv").trim().split("\n").filter(Boolean);
		for (const machine of machines)
			console.error(`--- console of ${machine}\n${lxc("exec", vm, "--", "lxc", "console", machine, "--show-log").split("\n").slice(-40).join("\n")}`);
	} catch {}
	try {
		console.error(`--- the database\n${JSON.stringify(await database.describe(db), null, 1)}`);
	} catch (error) {
		console.error(`--- the database: ${error.message}`);
	}
}
