// P3's driver, on the test machine (test/prove-coding-session-vm.sh runs it as root once the throwaway node is set up):
// the test database (p3-database.mjs) with a company whose member has a coding session, the node's executor
// (p3-executor.ts) started in the node as its service unit would start it, and the runtime's side of four turns:
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
// The executor's control RPCs come here over its stdout and run on the database as service_role; the runtime's coding
// command gateway (packages/runtime/src/cloud-coding-command-http.ts, bundled as p3-gateway.mjs) reaches the
// executor's command service through the same pipe. Prints PASS lines, then SESSION PROVEN.
// With P3_CUSTODY=1 (phase B only), turns 2 to 4 prove a member's vault secret in custody in place of the rest of
// Order 9 (p3-custody.mjs): the company's secret broker (p3-broker.ts, whose database calls run here as its own login)
// serves a made-up value to the session's commands, whose output masks it; turn 2's end would push a commit whose
// history carries it, and is refused; turn 3's end would save a file that carries it in the company folder, and is
// refused with the session still attached; turn 4 removes the file and publishes as turn 1 did. Then the tables, the
// node's files, the stand-in GitHub and the node's journal are searched for the value's forms, and it prints CUSTODY
// PROVEN before SESSION PROVEN. No line it prints carries a form (withhold).
//
//   node deploy/coding-worker/test/p3-driver.mjs <project> <node VM> <coding image fingerprint> <package directory> <node facts JSON>
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { brokerDatabase, custodyForms, databaseHolds, SAVE_REFUSED, value as databaseValue, withhold } from "./p3-custody.mjs";
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

// The executor's SQL control calls and the folder service's core calls: the last 60 (begun, kind, name, outcome, time)
// and those not answered yet.
const calls = { recent: [], pending: new Set() };

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
// The custody proof (P3_CUSTODY=1): a made-up value for a member's vault secret and the forms it is searched in, a
// control the run writes where the value may not go, the broker's ids, the executor's turn completions (outcome and
// summary), the broker's answers by status, and the turn outcome the proof expects next (no run stop for it).
const custody = process.env.P3_CUSTODY === "1" ? {
	probe: `p3probe-${randomBytes(24).toString("base64url")}`, control: `p3control-${randomBytes(16).toString("hex")}`,
	authorityId: randomUUID(), secretId: randomUUID(), keyId: "p3-kek-1", withheld: {}, completions: [], answers: {},
	expect: null, broker: null,
	startBroker: (await import(pathToFileURL(resolve(packageDirectory, "p3/p3-broker.mjs")).href)).startP3Broker,
} : null;
if (custody) {
	if (!node.codeHost) throw new Error("the custody proof needs phase B (P3_CODE_HOST=1)");
	custody.forms = custodyForms(custody.probe);
	withhold(process.stdout, custody.forms, custody.withheld);
	withhold(process.stderr, custody.forms, custody.withheld);
}

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
	if (custody) {
		// The company's secret broker, and a member's vault secret as its capture would leave it: the owner's own, named
		// p3_probe on the environment connector, which a session of theirs gets as P3_PROBE with no grant.
		const { authorityId, secretId, keyId } = custody;
		custody.broker = await custody.startBroker({ authorityId, keyId, database: brokerDatabase(db, note) });
		const envelope = Buffer.from(custody.broker.seal({ companyId: ids.profileId, environmentId: ids.environmentId, secretId, version: 1, keyId },
			custody.probe)).toString("hex");
		const q = database.quote;
		await db.psql([
			"begin;",
			"select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true), set_config('request.jwt.claim.role', 'service_role', true) \\g /dev/null",
			`insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
				values (${q(authorityId)}, ${q(ids.profileId)}, 'https://p3-broker.test', ${q(keyId)}, ${q(custody.broker.capabilitySha256)});`,
			`insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
				connector_id, secret_name, purpose, current_version, created_by_user_id)
				values (${q(secretId)}, ${q(ids.profileId)}, ${q(ids.environmentId)}, ${q(authorityId)}, 'member', ${q(ids.ownerUserId)},
				'environment', 'p3_probe', 'P3 custody probe', 1, ${q(ids.ownerUserId)});`,
			`insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
				envelope_sha256, created_by_user_id)
				values (${q(secretId)}, 1, ${q(authorityId)}, ${q(keyId)}, decode(${q(envelope)}, 'hex'),
				encode(extensions.digest(decode(${q(envelope)}, 'hex'), 'sha256'), 'hex'), ${q(ids.ownerUserId)});`,
			"commit;",
		].join("\n"));
		// The brokers' shared origin is a name only: the executor's broker client reaches it through the driver.
		config.broker = { origin: "https://p3-broker.test", executorTokenCredential: "qorpera-coding-broker-executor" };
		pushFile("/etc/qorpera/coding-broker-executor.key", custody.broker.executorToken);
		// What the node's searches look for, one per line, kept in the node as root (never in an argument).
		pushFile("/root/p3-custody-forms", custody.forms.join("\n"));
		pushFile("/root/p3-custody-control", custody.control);
		pass(`the company's secret broker runs, and the owner has a vault secret p3_probe: a made-up value of ${custody.probe.length} ` +
			`characters, searched for later in ${custody.forms.length} forms (${elapsed()})`);
	}
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
		if (custody && await databaseValue(db, `select to_jsonb(owner_user_id) from public.qorpera_runtime_workers where id = ${database.quote(workerId)}`) !== ids.ownerUserId)
			fail("the session's worker is not the vault secret's owner's");
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
		if (custody) await proveCustody({ ids, workerId, turn2, gateway2, head });
		else {
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
	await custody?.broker?.close().catch(() => undefined);
	postgrest?.stop();
	await db.close();
}

/** The custody proof (P3_CUSTODY=1), turns 2 to 4 in place of the rest of Order 9: the member's vault value reaches the
 * session's commands, and their output masks it; a push whose history carries it and a save of a file that carries it
 * are refused, each turn ending `failed` with the session still attached; a clean turn then publishes. Last, every place
 * the run could have kept the value is searched for its forms, and for the control, which shows each search reads that
 * place. Nothing printed holds the value: its length, counts, paths and the executor's own reasons. */
async function proveCustody({ ids, workerId, turn2, gateway2, head }) {
	const AUTHOR = "git -c user.name='P3 proof' -c user.email=p3@qorpera.invalid";
	const { forms, control } = custody;
	const carries = (text) => forms.some((form) => text.includes(form));
	const lastCompletion = (from) => custody.completions.slice(from).at(-1) ?? null;
	const attachment = () => databaseValue(db, `select to_jsonb(attached_machine_id) from public.qorpera_coding_sessions where worker_id = ${database.quote(workerId)}`);

	// --- The member's vault value reaches the session's commands as P3_PROBE, and their output masks it ----------------
	const held = await runToEnd(turn2, gateway2, "p3-custody-held", "printf 'len=%s\\n' \"${#P3_PROBE}\"; printf '%s' \"$P3_PROBE\" | sha256sum");
	if (held.state !== "succeeded" || held.output.trim() !== `len=${custody.probe.length}\n${sha256(custody.probe)}  -`)
		fail(`turn 2's commands do not hold the owner's vault value as P3_PROBE (${held.state}, ${held.output.length} characters of output)`);
	pass(`a member's vault secret reaches the session's commands: P3_PROBE has the length and SHA-256 of the value the broker serves (${elapsed()})`);
	const echoed = await runToEnd(turn2, gateway2, "p3-custody-echo", "printf 'probe=%s\\n' \"$P3_PROBE\"; printf '%s' \"$P3_PROBE\" | base64 -w0; echo; " +
		`printf '%s\\n' '${control}' >p3-control.txt; cat p3-control.txt`);
	const lines = echoed.output.split("\n");
	if (echoed.state !== "succeeded" || lines[0] !== "probe=***" || !lines[1]?.startsWith("***") || lines[2] !== control || carries(echoed.output))
		fail(`turn 2's command output does not mask the value beside a control: ${echoed.state}; printed whole ${lines[0] === "probe=***" ? "masked" : "NOT masked"}, ` +
			`in base64 ${lines[1]?.startsWith("***") ? "masked" : "NOT masked"}, the control ${lines[2] === control ? "kept" : "NOT kept"}, ` +
			`${carries(echoed.output) ? "a form of the value in it" : "no form of the value in it"}`);
	pass(`the command's output masks the value: printed whole it reads \`probe=***\`, its base64 starts \`***\`, and the control beside it ` +
		`is kept (${elapsed()})`);

	// --- Turn 2's end would push a history that carries the value: refused (CODING_PUSH_CARRIES_SECRET) ----------------
	// A file with the value is committed from the index alone and removed in the next commit: never in the worktree, so
	// only the history carries it.
	const history = await runToEnd(turn2, gateway2, "p3-custody-history",
		"blob=$(printf 'P3 custody\\n%s\\n' \"$P3_PROBE\" | git hash-object -w --stdin) && " +
		"git update-index --add --cacheinfo \"100644,$blob,p3-leak.txt\" && " +
		`${AUTHOR} commit -q -m 'P3 custody: a value in a file' && git rm -q --cached p3-leak.txt && ` +
		`${AUTHOR} commit -q -m 'P3 custody: the file removed' && ` +
		`echo "in-history=$(git log -p ${head}..HEAD | grep -cF "$P3_PROBE")" && ` +
		"echo \"in-tree=$(git grep -lF \"$P3_PROBE\" HEAD -- | wc -l)\" && git rev-parse HEAD");
	const committed = /in-history=(\d+)\nin-tree=\s*(\d+)\n([0-9a-f]{40})$/.exec(history.output.trim());
	if (history.state !== "succeeded" || committed?.[1] !== "2" || committed[2] !== "0")
		fail(`turn 2 cannot commit the value and remove it: ${history.state}, ${committed ? `${committed[1]} lines of the history, ${committed[2]} files of the tree` : "no counts"}`);
	const head2 = committed[3];
	pass(`turn 2 commits a file with the value and removes it in the next commit, ${head2}: its history carries the value ` +
		`(2 lines of \`git log -p\`), its tree does not (${elapsed()})`);
	const before2 = custody.completions.length;
	custody.expect = "failed";
	await database.finishTurn(db, turn2, { operationKey: "p3-turn-2", summary: "Read and stopped the command from turn 1; committed a file and removed it.", headSha: head2 });
	const settled2 = await executor.turnSettled();
	custody.expect = null;
	const refused2 = lastCompletion(before2);
	const where = /^The push was refused: (.*) carries one of the session's secret values\. Remove it from the history and finish again\.$/.exec(refused2?.summary ?? "");
	const pushed2 = published(workerId);
	if (settled2 !== "failed" || refused2?.outcome !== "failed" || !where || pushed2.sha !== head)
		fail(`turn 2's push of a history that carries the value is not refused: the turn settled ${settled2}, completed ${JSON.stringify(refused2)}, ` +
			`the branch is at ${pushed2.sha}`);
	pass(`turn 2's end is refused (CODING_PUSH_CARRIES_SECRET): the turn ends failed, "${refused2.summary}"; nothing is pushed, ` +
		`${pushed2.branch} stays at ${head} (${elapsed()})`);

	// --- Turn 3's end would save a file that carries the value: refused (CODING_FOLDER_SAVE_REFUSED) --------------------
	await database.followUp(db, ids, { workerId, text: "P3 proof: the push was refused; carry on." });
	const turn3 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 3, timeoutMs: 20 * 60000 });
	const gateway3 = gatewayFor(turn3);
	const attached = await attachment();
	pass(`turn 3 runs in the same session, attached to ${attached} (${elapsed()})`);
	const written = await runToEnd(turn3, gateway3, "p3-custody-file", `git reset -q --hard ${head} && printf '%s' "$P3_PROBE" >p3-probe.txt && ` +
		"echo \"in-file=$(grep -cF \"$P3_PROBE\" p3-probe.txt)\"");
	if (written.state !== "succeeded" || written.output.trim() !== "in-file=1") fail(`turn 3 cannot write the value in a file: ${written.state}`);
	const before3 = custody.completions.length;
	custody.expect = "failed";
	await database.finishTurn(db, turn3, { operationKey: "p3-turn-3", summary: "Wrote a file.", headSha: head });
	const settled3 = await executor.turnSettled();
	custody.expect = null;
	const refused3 = lastCompletion(before3);
	const still = await attachment();
	const pushed3 = published(workerId);
	if (settled3 !== "failed" || refused3?.outcome !== "failed" || refused3.summary !== SAVE_REFUSED || !attached || still !== attached || pushed3.sha !== head)
		fail(`turn 3's save of a file that carries the value is not refused: the turn settled ${settled3}, completed ${JSON.stringify(refused3)}, ` +
			`the session attached to ${attached} then ${still}, the branch at ${pushed3.sha}`);
	pass(`turn 3's end is refused (CODING_FOLDER_SAVE_REFUSED): the turn ends failed with a reason that names no path, "${refused3.summary}"; ` +
		`nothing is published, and the session stays attached to ${still} (${elapsed()})`);

	// --- Turn 4 removes the file and publishes through the repository's credential --------------------------------------
	await database.followUp(db, ids, { workerId, text: "P3 proof: the save was refused; remove the file and finish." });
	const turn4 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 4, timeoutMs: 20 * 60000 });
	const gateway4 = gatewayFor(turn4);
	const cleaned = await runToEnd(turn4, gateway4, "p3-custody-clean",
		`rm -f p3-probe.txt && git add p3-control.txt && ${AUTHOR} commit -q -m 'P3 custody: a control' && git rev-parse HEAD`);
	const head4 = cleaned.output.trim().split("\n").at(-1);
	if (cleaned.state !== "succeeded" || !/^[0-9a-f]{40}$/.test(head4 ?? "")) fail(`turn 4 cannot remove the file and commit: ${cleaned.state}`);
	const before4 = custody.completions.length;
	// The control in the turn's summary too: the table search must find it.
	await database.finishTurn(db, turn4, { operationKey: "p3-turn-4", summary: `Removed the file; committed the control ${control}.`, headSha: head4 });
	const settled4 = await executor.turnSettled();
	const done4 = lastCompletion(before4);
	let pushed4 = published(workerId);
	for (let waited = 0; (pushed4.sha !== head4 || !pushed4.pull) && waited < 60000; waited += 2000, pushed4 = published(workerId))
		await new Promise((settle) => setTimeout(settle, 2000));
	if (settled4 !== "completed" || done4?.outcome !== "succeeded" || pushed4.sha !== head4 || pushed4.pull?.draft !== true || pushed4.pull.head.sha !== head4)
		fail(`turn 4's end does not publish: the turn settled ${settled4}, completed ${done4?.outcome}, ${JSON.stringify(pushed4)}`);
	pass(`turn 4 removes the file and commits the control, ${head4}; its end pushes it through the repository's credential, and the ` +
		`draft pull request ${pushed4.pull.html_url} has it (${elapsed()})`);

	// --- Where the run could have kept the value -----------------------------------------------------------------------
	// Every problem is gathered, then the run fails once; only counts and paths are printed.
	const problems = [];
	const holds = await databaseHolds(db, [...forms, control]);
	const formTables = [...new Set(holds.slice(0, forms.length).flat())];
	const controlTables = holds.at(-1);
	if (formTables.length) problems.push(`the tables ${formTables.join(", ")} hold a form of the value`);
	if (!controlTables.length) problems.push("no table holds the control");
	const audited = await databaseValue(db, "select to_jsonb(count(*)) from public.qorpera_cloud_secret_audit_events " +
		`where event_type = 'environment_secret_used' and coding_worker_id = ${database.quote(workerId)}`);
	if (!(audited >= 1)) problems.push("the broker audited no use of the secret by the session");
	// The node's files: its NAS, the object store and its state, the stand-in GitHub, the folder service's and the
	// executor's runtime directories, logs, temporary folders, configuration and LXD's logs. Not the coding machines' disks.
	const PLACES = "places=(); for place in /srv/nas /srv/p3-objects/state /srv/p3-objects/store /srv/p3-github /srv/qorpera " +
		"/run/qorpera-folder-* /run/qorpera-coding-host /var/log /tmp /var/tmp /etc /var/snap/lxd/common/lxd/logs /var/lib/qorpera*; " +
		"do [[ -e $place ]] && places+=(\"$place\"); done; grep -rlsF -D skip -f \"$1\" \"${places[@]}\" || true";
	const search = (script, needles) => lxc("exec", vm, "--", "bash", "-c", script, "p3", needles).trim();
	const STORED = /^\/srv\/p3-objects\/store\/.*\/([0-9a-f]{64})$/;
	const fileHits = search(PLACES, "/root/p3-custody-forms").split("\n").filter(Boolean);
	const elsewhere = fileHits.filter((path) => !STORED.test(path));
	if (elsewhere.length) problems.push(`files in the node hold a form of the value: ${elsewhere.join(", ")}`);
	// An object in the store is the folder's only once a path version names it, itself or as a chunk of its manifest; a
	// refused save's bytes may wait there, unnamed, until the store's GC.
	const stored = fileHits.map((path) => STORED.exec(path)?.[1]).filter(Boolean);
	const named = stored.length ? await databaseValue(db, `select coalesce(jsonb_agg(s), '[]'::jsonb) from unnest(${database.quote(`{${stored.join(",")}}`)}::text[]) as s
		where exists (select 1 from public.qorpera_folder_path_versions v where s in (v.file_sha256, v.manifest_sha256))
			or exists (select 1 from public.qorpera_folder_file_chunks c join public.qorpera_folder_path_versions v on v.manifest_sha256 = c.manifest_sha256
				where c.chunk_sha256 = s)`) : [];
	if (named.length) problems.push(`the company folder saved a form of the value: the objects ${named.join(", ")}`);
	const controlFiles = search(PLACES, "/root/p3-custody-control").split("\n").filter(Boolean);
	if (!controlFiles.length) problems.push("no file in the node holds the control");
	const GITHUB = "git --git-dir /srv/p3-github/qorpera-p3/proof.git cat-file --batch-all-objects --batch | grep -caF -f \"$1\" || true";
	const githubForms = Number(search(GITHUB, "/root/p3-custody-forms"));
	const githubControl = Number(search(GITHUB, "/root/p3-custody-control"));
	if (githubForms !== 0) problems.push(`the stand-in GitHub's objects hold a form of the value (${githubForms} lines)`);
	if (!(githubControl >= 1)) problems.push("the stand-in GitHub's objects do not hold the control");
	// The control goes to the journal here, after the file search, so the journal's search reads it.
	search("logger -t p3-custody -- \"$(cat \"$1\")\"; journalctl --sync 2>/dev/null; sleep 1", "/root/p3-custody-control");
	const JOURNAL = "journalctl --no-pager -o cat | grep -caF -f \"$1\" || true";
	const journalForms = Number(search(JOURNAL, "/root/p3-custody-forms"));
	const journalControl = Number(search(JOURNAL, "/root/p3-custody-control"));
	if (journalForms !== 0) problems.push(`the node's journal holds a form of the value (${journalForms} lines)`);
	if (!(journalControl >= 1)) problems.push("the node's journal does not hold the control");
	const withheld = Object.entries(custody.withheld).filter(([, count]) => count > 0);
	if (withheld.length) problems.push(`lines the driver would have printed carried a form: ${withheld.map(([source, count]) => `${source} ${count}`).join(", ")}`);
	if (problems.length) fail(`the value was kept: ${problems.join("; ")}`);
	pass(`the value is kept nowhere it was searched for: no table (the control is in ${controlTables.length}), no file in the node ` +
		`(the control is in ${controlFiles.length}), no object of the stand-in GitHub (the control is in ${githubControl} lines), not the node's ` +
		`journal (the control is in ${journalControl} lines), no line the driver printed; ` +
		`${stored.length ? `LIMIT: ${stored.length} unsaved objects in the store hold it until the store's GC; ` : ""}` +
		`the broker answered ${JSON.stringify(custody.answers)} and audited ${audited} uses (${elapsed()})`);
	console.log("CUSTODY PROVEN");
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
		...(custody ? ["LoadCredential=qorpera-coding-broker-executor:/etc/qorpera/coding-broker-executor.key"] : []),
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
	// The folder model's own lines: the executor's start (its two pins) and each view it mounts.
	const folderLines = { start: null, mounts: [] };
	createInterface({ input: child.stderr }).on("line", (line) => {
		console.error(`executor: ${line}`);
		let logged;
		try {
			logged = JSON.parse(line);
		} catch {
			return;
		}
		if (logged?.event === "coding-executor-folder") folderLines.start = line;
		else if (logged?.event === "coding-folder-mount") folderLines.mounts.push(line);
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
				else if (custody && name === "qorpera_complete_coding_turn") {
					const completed = JSON.parse(message.body ?? "{}");
					custody.completions.push({ outcome: completed.p_outcome, summary: completed.p_summary });
				}
				send({ t: "rest", id: message.id, status: answer.status, body: answer.body });
			});
		} else if (message.t === "broker") {
			// The executor's broker client (../coding-environment.ts), answered by the run's broker; neither body nor headers
			// are logged.
			if (!custody?.broker) send({ t: "broker", id: message.id, status: 0 });
			else void timed("broker", "coding-environment", fetch(`http://127.0.0.1:${custody.broker.port}${message.path}`, {
				method: message.method, headers: message.headers, body: message.body ?? undefined, redirect: "error", signal: AbortSignal.timeout(30000),
			}).then(async (response) => ({ status: response.status, body: await response.text() }))).then((answer) => {
				custody.answers[answer.status] = (custody.answers[answer.status] ?? 0) + 1;
				if (answer.status !== 200) note(`the broker answered ${answer.status}`);
				send({ t: "broker", id: message.id, status: answer.status, body: answer.body });
			}, (error) => {
				note(`the broker is unreachable: ${error?.message}`);
				send({ t: "broker", id: message.id, status: 0 });
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
			// No later step can pass after such a turn, unless the custody proof expects it: end the run now, not at the
			// deadline of what the driver waits for.
			if (custody?.expect && custody.expect === message.status) custody.expect = null;
			else if (["blocked", "failed", "recovery-required"].includes(message.status)) void stopRun(`the executor's turn settled ${message.status}`);
			const waiter = turnWaiters.shift();
			if (waiter) waiter(message.status);
			else settledTurns.push(message.status);
		} else note(`executor: ${line.slice(3)}`);
	});
	return {
		ready,
		folderLines,
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
		if (method === "POST" && rpc)
			return { name: rpc[1], status: 200, body: JSON.stringify(await database.rpc(db, rpc[1], body ? JSON.parse(body) : {})) };
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
