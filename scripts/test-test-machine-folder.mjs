import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expandTestFixture } from "./test-hosted-db.mjs";
import { hostedDatabase } from "./test-hosted-db-cluster.mjs";

// P4 (deploy/test-machine/TEST-MACHINE-FOLDER.md): an agent's test machine works with the company folder, from the
// gateway's machine command call to the folder core. Run by scripts/prove-test-machine-folder-vm.sh on a node's test
// machine, as root, with a stand-in test machine image in a project and pool that script claimed:
//
//   gateway (createHttpCloudMachineCommandGateway, per run, with the run's holder)
//   -> the executor's command service (HttpCloudCodingCommandService: qorpera_native_binding_proven,
//      qorpera_authorize_machine_command, MachineCommandRouter)
//   -> the executor's test machine host (LxdCompanyMachineHost, 6d-1) and its pass loop
//   -> an LXD VM made from the image (6c's guest package)
//   -> the node folder service (FolderService, its control and folder sockets, the folder program's vsock bridge; 6b)
//      serving the boot's test_machine view (6a)
//   -> the folder core in Postgres (a hosted database with every migration, through a PostgREST stand-in).
//
// The company, its runs and the machine executor are SQL test 628's fixture (924's base). Everything this proves is
// written to --record as evidence; the checks are judged from it, and the record is scanned for the run's secrets.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
	"usage: test-test-machine-folder.mjs --project <qtm-x> --pool <qtm-x> --image <sha256> --bootstrap-sha256 <sha256> " +
	"--helper-sha256 <sha256> --folder-binary <path> --work <dir> --record <file> --execute";
const DATABASE = "qorpera_p4_test_machine";
const SERVICE = { role: "service_role" };
const ORIGIN = "https://postgrest.p4.invalid";
const STAND_IN = "p4-stand-in";
const OWNER = "92400000-0000-4000-8000-000000000001";
const ENV = "92400000-0000-4000-8000-000000000020";
const STAFF = {
	alice: "92400000-0000-4000-8000-000000000030",
	bob: "92400000-0000-4000-8000-000000000031",
	carol: "92400000-0000-4000-8000-000000000032",
};
const NODE_ID = "92400000-0000-4000-8000-0000000004a0";
const EXECUTOR = "p4-executor";
const PROVIDER = "machine-fixture";
const MACHINE = "p4";
const HELPER = "/opt/qorpera-machine/cloud-machine-guest.mjs";
/** 628's own checks start here; its helpers and 924's base before it are the fixture. */
const FIXTURE_CUT = "-- 1. Without a machine executor";
const SEED = "# P4\n\nThe company folder, as a test machine reads it.\n";
const MOUNTED = "FOLDER_MOUNTED";
/** 6e-1: a test machine's placement binding, without the repository worker or its disk. */
export const V2 = "qorpera.lxd-company-machine/v2";
/** The service's quiet period: a change is published this long after the last one (6b). */
const QUIET_MS = 2000;
/** The executor's detail on an open that moves the machine to a new disk (6d-2). */
export const NEW_DISK = "qorpera.test-machine/new-disk";
/** The receipts' words (6e-2a), as the host and the contracts say them: kept here so a change of words is seen. */
export const WORDS = Object.freeze({
	heldStart: "a start shows no output: machine_read shows it once the company folder has released what the machine read",
	heldUnanswered: "the company folder has not said yet whether what the machine read may be shown; read again",
	heldEnded: "this boot's output stays on the machine: the boot no longer has /company, as `why` says",
	endedViewClosed: "the executor is restarting the machine because its /company view was closed",
	refused: "the company folder refused this machine's view",
	lostViewClosed: "the executor restarted the machine because its /company view was closed",
});

const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const token = () => randomBytes(32).toString("base64url");

/** A SQL literal for one value. */
export const literal = (value) =>
	value === null || value === undefined
		? "null"
		: typeof value === "number" || typeof value === "boolean"
			? String(value)
			: `'${(typeof value === "object" ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'${typeof value === "object" ? "::jsonb" : ""}`;

export function parseArgs(argv) {
	const names = {
		"--project": "project",
		"--pool": "pool",
		"--image": "image",
		"--bootstrap-sha256": "bootstrapSha256",
		"--helper-sha256": "helperSha256",
		"--folder-binary": "folderBinary",
		"--work": "work",
		"--record": "record",
	};
	const options = { execute: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--execute" && !options.execute) {
			options.execute = true;
			continue;
		}
		const name = names[argv[i]];
		if (!name || name in options || i + 1 >= argv.length) throw new Error(USAGE);
		options[name] = argv[++i];
	}
	if (!options.execute) return options;
	if (Object.values(names).some((name) => typeof options[name] !== "string")) throw new Error(USAGE);
	if (!/^qtm-[0-9a-f]{8}$/.test(options.project) || options.pool !== options.project)
		throw new Error("The project and pool are the claimed qtm-<8 hex> names");
	for (const name of ["image", "bootstrapSha256", "helperSha256"])
		if (!/^[0-9a-f]{64}$/.test(options[name])) throw new Error(`--${name} is a sha-256`);
	for (const name of ["folderBinary", "work", "record"])
		if (!isAbsolute(options[name]) || resolve(options[name]) !== options[name]) throw new Error(`${name} is an absolute path`);
	if (dirname(options.record) !== options.work) throw new Error("The record is written in the work directory");
	return options;
}

/** PostgREST's HTTP status for a SQLSTATE. */
export function postgrestStatus(code) {
	if (code === "42501") return 403;
	if (code === "23503" || code === "23505") return 409;
	if (code === "P0001") return 400;
	if (code === "42883" || code === "42P01") return 404;
	const group = code.slice(0, 2);
	if (group === "08" || group === "53") return 503;
	if (["0L", "0P", "28"].includes(group)) return 403;
	if (["09", "25", "2D", "38", "39", "3B", "40", "54", "55", "57", "58", "F0", "HV", "P0", "XX"].includes(group)) return 500;
	return 400;
}

/** psql's verbose error, as PostgREST answers it: the SQLSTATE as `code`, and its DETAIL (the executor reads a view
 * open's refusal from it). Null for output that is not a database error. */
export function postgrestFailure(text) {
	const failed = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(text);
	if (!failed) return null;
	const detail = /^DETAIL:\s+(.*)$/m.exec(text);
	return {
		status: postgrestStatus(failed[1]),
		value: { code: failed[1], details: detail ? detail[1] : null, hint: null, message: failed[2] },
	};
}

/** psql's verbose error as the evidence keeps it: the SQLSTATE, the message, every DETAIL line (a deadlock's waits),
 * the row lock it was taking (CONTEXT's "while locking tuple … in relation …") and the PL/pgSQL functions it was
 * raised in, innermost first. Null for output that is not a database error. */
export function sqlError(text) {
	const sections = {};
	let at = null;
	for (const line of String(text).split("\n")) {
		const error = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)$/.exec(line);
		const start = /^(DETAIL|HINT|CONTEXT|LOCATION|QUERY|STATEMENT):\s+(.*)$/.exec(line);
		if (error && !sections.ERROR) {
			sections.ERROR = [error[2]];
			sections.code = error[1];
			at = "ERROR";
		} else if (start && sections.ERROR && !sections[start[1]]) {
			at = start[1];
			sections[at] = [start[2]];
		} else if (at) sections[at].push(line);
	}
	if (!sections.code) return null;
	const context = (sections.CONTEXT ?? []).join("\n");
	const lock = /while (\w+) tuple \(([0-9]+,[0-9]+)\) in relation "([^"]+)"/.exec(context);
	return {
		code: sections.code,
		message: sections.ERROR[0].slice(0, 300),
		details: sections.DETAIL ? sections.DETAIL.join("\n").trim().slice(0, 600) : null,
		lock: lock ? { relation: lock[3], tuple: `(${lock[2]})`, while: lock[1] } : null,
		functions: [...context.matchAll(/^PL\/pgSQL function ([A-Za-z0-9_.]+)\(/gm)].map((m) => m[1]),
	};
}

/** Every deadlock the run's SQL hit: the executor's, the folder core's and the object authority's calls (`rpcFailures`)
 * and the keeper's. */
export function deadlocksIn(evidence) {
	return [...(evidence.service?.rpcFailures ?? []), ...(evidence.keeper?.errors ?? [])]
		.filter((f) => f?.code === "40P01")
		.map((f) => ({ t: f.t, function: f.method ?? f.function ?? null, code: f.code, in: f.in ?? [], lock: f.lock ?? null,
			waits: f.waits ?? f.details ?? null }))
		.sort((a, b) => a.t - b.t);
}

/** How `path`'s unit was answered once `sinceAt` (epoch ms; `sinceT`, the same in the run's seconds): in a boundary's
 * report, or in the service's log by the quiet period's publish. `waiting` (its bytes are not saved yet) is no answer:
 * a boundary that runs while the write is still on its way says it, and a later boundary or publish answers. */
export function answeredUnit(ops, serviceLog, path, sinceAt, sinceT) {
	for (const o of ops.filter((x) => x.at >= sinceAt && x.answer?.views))
		for (const view of o.answer.views)
			for (const entry of view.report?.paths ?? [])
				if (entry.path === path && entry.outcome !== "waiting") return { op: o.op, t: o.t, ...entry };
	const quoted = path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	const pattern = new RegExp(`^([0-9.]+) .*: ${quoted}: ([a-z_]+)(?: \\((.*)\\))?$`);
	for (const line of serviceLog) {
		const logged = pattern.exec(line);
		if (logged && logged[2] !== "waiting" && Number(logged[1]) >= sinceT)
			return { op: "quiet", t: Number(logged[1]), path, outcome: logged[2], reason: logged[3] ?? null };
	}
	return null;
}

/** `text` with `from` replaced by `to`, exactly `count` times (any number but none when `count` is null). */
export function replaceCounted(text, from, to, count) {
	const found = text.split(from).length - 1;
	if (count === null ? found === 0 : found !== count)
		throw new Error(`P4_FIXTURE_CHANGED: ${JSON.stringify(from)} occurs ${found} times`);
	return text.replaceAll(from, to);
}

/** 628's fixture (924's base and 628's helpers), cut before its checks and kept for this run: Alice's run as 924
 * starts it, then Bob's and Carol's, each with this run's lease token digest (its holder proves it); 628's machine
 * helpers in schema p4 for later sessions; the node, its machine provider and the executor with the claimed project's
 * policy. Answers each run's binding on a `@@p4-<name>` line. */
export function fixtureSql(expanded, setup) {
	const cut = expanded.indexOf(FIXTURE_CUT);
	if (cut < 0) throw new Error("P4_FIXTURE_CHANGED: no cut");
	let body = expanded.slice(0, cut);
	body = replaceCounted(body, "repeat('3', 64)", "pg_temp.p4_lease_sha()", 3);
	body = replaceCounted(body, "pg_temp.mc_", "p4.mc_", null);
	body = replaceCounted(body, "'project','machines','name'", `'project',${literal(setup.project)},'name'`, 1);
	// mc_observe made from 628's own, with the node's inventory context as a parameter: the keeper reads the context in
	// its own transaction and observes in a second, as the real observer's two calls do, so it never holds the node
	// (the context's FOR SHARE) and then waits for an allocation the host's reserve holds (allocation, then node).
	const observe = /^create function p4\.mc_observe\(p_id uuid,p_sha text,p_cpu bigint,p_memory bigint\) returns void language plpgsql as \$\$\n[\s\S]*?^\$\$;$/m.exec(body);
	if (!observe) throw new Error("P4_FIXTURE_CHANGED: no mc_observe");
	let observeWith = replaceCounted(observe[0], "create function p4.mc_observe(p_id uuid,p_sha text,p_cpu bigint,p_memory bigint)",
		"create function p4.mc_observe_with(p_id uuid,p_sha text,p_cpu bigint,p_memory bigint,p_context jsonb)", 1);
	observeWith = replaceCounted(observeWith, "declare v_context jsonb := public.qorpera_runtime_node_inventory_context(p_id);\n", "", 1);
	observeWith = replaceCounted(observeWith, "v_context", "p_context", 2);
	const run = (name, text) => `select set_config('p4.lease_sha', ${literal(setup.leaseSha[name])}, false) \\g /dev/null
do $$
declare v_wakes jsonb := pg_temp.base_post(${literal(OWNER)}, ${literal(STAFF[name])}, ${literal(text)});
	v_pass jsonb; v_binding jsonb;
begin
	perform pg_temp.base_assert(jsonb_array_length(v_wakes) = 1, 'P4: the post wakes ${name} once: ' || v_wakes::text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1,
		'P4: ${name}''s run: ' || v_pass::text);
	v_binding := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	insert into p4.setup values (${literal(name)}, v_binding);
	perform pg_temp.base_public_send(v_binding, 'progress', 'machine-ack');
end
$$;
select pg_temp.base_claims('service_role') \\g /dev/null`;
	return [
		"create schema p4;",
		"create table p4.setup(name text primary key, value jsonb not null);",
		`select set_config('p4.lease_sha', ${literal(setup.leaseSha.alice)}, false) \\g /dev/null`,
		"create function pg_temp.p4_lease_sha() returns text language sql as $$ select current_setting('p4.lease_sha') $$;",
		body,
		observeWith,
		"insert into p4.setup values ('alice', current_setting('qorpera_test.base_binding')::jsonb);",
		run("bob", "Prove the test machine with Bob."),
		run("carol", "Prove the test machine with Carol."),
		`do $$
begin
	perform p4.mc_node(${literal(NODE_ID)}, ${literal(setup.nodeSha)}, 'p4-node', 16000, 68719476736);
	perform public.qorpera_enroll_runtime_node_provider(${literal(NODE_ID)}, ${literal(setup.nodeSha)}, 'machine', ${literal(PROVIDER)},
		repeat('f', 64), 8000, 34359738368);
	perform public.qorpera_configure_machine_executor(${literal(EXECUTOR)}, ${literal(setup.nodeSha)}, true, ${literal(setup.policy)},
		322122547200);
	perform pg_temp.base_assert(public.qorpera_company_machines_available(), 'P4: the executor offers machines');
end
$$;`,
		"select '@@p4-' || name || ' ' || value::text from p4.setup order by name;",
		"commit;",
		"",
	].join("\n");
}

/** The LXD client the host is given: the machines' NIC is left out of what LXD makes (this proof makes no network on
 * the shared test machine), and put back in what LXD answers, so the host's own instance check holds; each view's
 * hand-over (folder-mount's stdin) goes to `onHandover` before the guest is asked. */
export function nicStandIn(client, nics = new Map(), onHandover = () => {}) {
	const withNic = (instance, nic) => {
		if (!instance || typeof instance !== "object") return instance;
		const next = { ...instance };
		for (const key of ["devices", "expandedDevices", "expanded_devices"])
			if (next[key] && typeof next[key] === "object") next[key] = { ...next[key], network: nic };
		return next;
	};
	return new Proxy(client, {
		get(target, property) {
			if (property === "submitInstanceOperation")
				return async (project, operation, signal) => {
					if (operation?.action === "create" && operation.request?.devices?.network) {
						const { network, ...devices } = operation.request.devices;
						nics.set(operation.request.name, network);
						operation = { ...operation, request: { ...operation.request, devices } };
					}
					return target.submitInstanceOperation(project, operation, signal);
				};
			if (property === "getInstance")
				return async (project, name, signal) => {
					const instance = await target.getInstance(project, name, signal);
					return nics.has(name) ? withNic(instance, nics.get(name)) : instance;
				};
			if (property === "execInstanceStream")
				return async (project, name, request, signal) => {
					if (request?.command?.at(-1) === "folder-mount")
						onHandover({ project, name, stdin: Buffer.from(request.stdin) });
					return target.execInstanceStream(project, name, request, signal);
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** Keeps each hand-over in memory, for the second machine's attempt, with the view it names; and its pass among the
 * run's secrets the moment it is seen, so the record is checked for every boot's pass, a run that fails early too. A
 * hand-over that is not the JSON expected is kept whole as the secret. */
export function keepHandover(handovers, secrets) {
	return (handover) => {
		const text = handover.stdin.toString("utf8");
		let said = null;
		try {
			said = JSON.parse(text);
		} catch {}
		secrets[`viewPass${handovers.length + 1}`] = typeof said?.pass === "string" ? said.pass : text;
		handovers.push({ ...handover, viewId: typeof said?.viewId === "string" ? said.viewId : null });
	};
}

/** Which of the run's secrets (name to value) appear in `text`. */
export function findSecrets(text, secrets) {
	return Object.entries(secrets)
		.filter(([, value]) => typeof value === "string" && value.length >= 16 && text.includes(value))
		.map(([name]) => name);
}

const unitOf = (commits, path) => {
	for (const commit of [...(commits ?? [])].reverse()) {
		const unit = (commit.units ?? []).find((u) => u.path === path);
		if (unit)
			return Array.isArray(unit.credits)
				? { commit, unit, credits: unit.credits, from: "unit" }
				: { commit, unit, credits: commit.credits ?? null, from: "commit" };
	}
	return null;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && same([...a].sort(), [...b].sort());

/** The snap LXD daemon, the one whose socket the bridge is given. */
const LXD_DAEMON = /^\/snap\/lxd\/[^/]+\/sbin\/lxd$/;

/** The vsock owner rule, port by port: for each port of the host (CID 2) that answered the guest, the allowed owner
 * holding it (`bridge`, `lxd`, `sshd-vsock` or `lxd-agent`), or null. 5250 must be this run's bridge; LXD's own listener
 * is allowed by owner and its CID-2 binding, whatever its port, and only once; 22 (systemd's sshd-vsock.socket) and 8443
 * (lxd-agent) only when `systemd-detect-virt --vm` says the test machine is a VM. Anything else, or no owner, is null. */
export function vsockOwnerRule(vsock) {
	const vm = typeof vsock?.virt === "string" && vsock.virt !== "" && vsock.virt !== "none";
	const listeners = Array.isArray(vsock?.listeners) ? vsock.listeners : [];
	const answered = Array.isArray(vsock?.probe?.answered) ? vsock.probe.answered : [];
	const bridgePid = Number.isSafeInteger(vsock?.bridgePid) && vsock.bridgePid > 0 ? vsock.bridgePid : null;
	const ownedBy = (l, test) => Array.isArray(l.processes) && l.processes.length > 0 && l.processes.every(test);
	let lxd = 0;
	return answered.map((port) => {
		const on = listeners.filter((l) => l.port === port && (l.cid === "*" || l.cid === "2"));
		if (on.length !== 1) return { port, owner: null, why: on.length ? "more than one listener" : "no owner" };
		const [l] = on;
		if (port === 5250)
			return { port, owner: bridgePid !== null && ownedBy(l, (p) => p.pid === bridgePid) ? "bridge" : null };
		if (l.cid === "2" && ownedBy(l, (p) => p.name === "lxd" && LXD_DAEMON.test(p.exe ?? "")))
			return ++lxd === 1 ? { port, owner: "lxd" } : { port, owner: null, why: "a second LXD port" };
		if (port === 22 && vm && l.unit === "sshd-vsock.socket" && ownedBy(l, (p) => p.pid === 1 && p.name === "systemd"))
			return { port, owner: "sshd-vsock" };
		if (port === 8443 && vm && ownedBy(l, (p) => p.name === "lxd-agent" && /\/lxd-agent$/.test(p.exe ?? "")))
			return { port, owner: "lxd-agent" };
		return { port, owner: null };
	});
}

/** The checks, from the evidence alone. */
export function judge(evidence, leaks = []) {
	const s = evidence.steps ?? {};
	const checks = {};
	const check = (name, ok, why) => {
		checks[name] = { ok: Boolean(ok), why };
	};
	const boot = s.boot ?? {};
	check(
		"bootMounted",
		boot.mounted === true && boot.view?.kind === "test_machine" && boot.view?.state === "open" &&
			boot.receipt?.state === "succeeded" && boot.receipt?.exitCode === 0 && boot.receipt?.output?.includes(SEED.trim().split("\n").at(-1)),
		"the host's pass mounted the boot's test_machine view and a command read the company's file under /company",
	);
	const placement = boot.placement ?? {};
	check(
		"v2Binding",
		placement.id === boot.placementId && placement.schema === V2 && placement.repositoryWorkerId === false &&
			Array.isArray(boot.devices) && boot.devices.length > 0 &&
			!boot.devices.some((d) => d.name === "repository" || String(d.path ?? "").startsWith("/mnt/repository")) &&
			/^no-repository$/m.test(boot.receipt?.output ?? "") && !boot.receipt.output.includes("repository-present"),
		"the placement's binding is v2 (no repository worker), the VM has no repository disk, and the machine has no " +
			"/mnt/repository",
	);
	const credit = s.credit ?? {};
	const refusals = s.refusals ?? {};
	const k = refusals.k ?? {};
	const stop = s.stop ?? {};
	const wake = stop.wake ?? {};
	// The receipts' company folder (6e-2a): mounted with nothing to say, held back with the host's words, never lost
	// where SQL (not the folder) ended a command.
	const folderOf = (r) => r?.companyFolder ?? null;
	const plainMounted = (r) => {
		const f = folderOf(r);
		return f?.company === "mounted" && f.why == null && f.heldBack == null && f.lost == null;
	};
	const heldWith = (r, words) => {
		const f = folderOf(r);
		return f?.company === "mounted" && f.why == null && f.heldBack === words && f.lost == null;
	};
	const unlost = (refused) => Boolean(refused) && refused.lost == null && refused.folderLost == null;
	check(
		"reportOnReceipts",
		heldWith(boot.startReceipt, WORDS.heldStart) && plainMounted(boot.receipt) && heldWith(credit.start, WORDS.heldStart) &&
			heldWith(credit.heldRead, WORDS.heldUnanswered) && plainMounted(credit.released) &&
			k.resent?.code === "MACHINE_COMMAND_ENDED" && unlost(k.resent) &&
			(k.read?.receipt ? k.read.receipt.companyFolder?.company === "mounted" && k.read.receipt.companyFolder.lost == null
				: unlost(k.read?.refused)) &&
			plainMounted(refusals.stillReads) && plainMounted(wake.receipt),
		"company mounted on the boot's commands; heldBack on a start and on A's held read, gone once released; no lost on " +
			"K's refusal or read, which SQL (not the folder) ended",
	);
	// A receipt that shows nothing yet: no output, no end and an empty log.
	const withheld = (r) => r?.state === "running" && r.output === "" && r.exitCode === null && r.totalBytes === 0;
	check(
		"heldUntilReleased",
		withheld(credit.start) && withheld(credit.heldRead) && credit.heldBoundaries > 0 &&
			credit.released?.state === "succeeded" && credit.released?.exitCode === 0 &&
			credit.released?.output?.includes("wrote-alice") && credit.released?.totalBytes > 0 && credit.releasedFirst === true,
		"while no boundary answered, the start and a read of the finished command both got running, no output, no exit " +
			"code and an empty log; the output and its end came after a released boundary",
	);
	const a = unitOf(credit.commits, "p4/alice.txt");
	check(
		"creditedToCommand",
		a && same(a.credits, [credit.commandId]) && a.commit.actorKind === "staff_agent" && a.commit.actorId === STAFF.alice &&
			a.commit.runId === credit.runId && a.commit.requesterId === OWNER && a.commit.viewKind === "test_machine",
		"p4/alice.txt is committed with credits [A], actor Alice's staff agent, run R and requester M, from the test_machine view",
	);
	const overlap = s.overlap ?? {};
	const bobOnly = unitOf(overlap.commits, "p4/bob-only.txt");
	const shared = unitOf(overlap.commits, "p4/shared.txt");
	const after = unitOf(overlap.commits, "p4/carol-after.txt");
	check(
		"overlapCredited",
		bobOnly && same(bobOnly.credits, [overlap.b]) && bobOnly.commit.actorId === STAFF.bob &&
			shared && sameSet(shared.credits, [overlap.b, overlap.c]) &&
			after && same(after.credits, [overlap.c]) && after.commit.actorId === STAFF.carol &&
			overlap.receipts?.b?.exitCode === 0 && overlap.receipts?.c?.exitCode === 0,
		"overlapping commands of Bob's and Carol's runs: bob-only.txt [B], shared.txt [B,C], carol-after.txt [C]",
	);
	const reads = s.reads ?? {};
	const took = (t) =>
		t?.schema === "qorpera.folder-inherit/v1" && t.viewId === reads.viewId && t.replay === false && Number.isInteger(t.reads) &&
		t.reads > 0;
	// Bob's run may take the view in only as a company-audience run whose agent and member read the root (6a-3): the
	// fixture gives it both, so a refusal is a failure.
	const bob = reads.bobAuthority ?? {};
	check(
		"readsTakenIn",
		reads.viewId && reads.viewId === boot.view?.id && reads.viewReads?.includes("p4/seed.md") &&
			reads.aliceRunReads?.includes("p4/seed.md") && took(reads.alice) &&
			bob.staffAgentId === STAFF.bob && bob.staffAgentId !== boot.view?.staffAgentId && bob.audience === "company" &&
			bob.readsRoot === true && Array.isArray(reads.bobBefore) && reads.bobBefore.length === 0 && took(reads.bob) &&
			sameSet(reads.bobAfter, reads.viewReads),
		"the view's reads reached Alice's run and her run took them in (6a-3, through SQL); Bob's run, another agent's with " +
			"the company audience and the root, had none and took in exactly the view's",
	);
	const vsock = s.vsockPorts ?? {};
	const owned = vsockOwnerRule(vsock);
	const answeredPorts = Array.isArray(vsock.probe?.answered) ? vsock.probe.answered : [];
	check(
		"vsockPorts",
		vsock.receipt?.exitCode === 0 && vsock.probe?.scanned === 65535 && vsock.probe.timeoutCount === 0 &&
			typeof vsock.virt === "string" && new Set(answeredPorts).size === answeredPorts.length &&
			owned.some((o) => o.port === 5250 && o.owner === "bridge") && owned.every((o) => o.owner !== null) &&
			sameSet(vsock.ports?.map((p) => p.port), answeredPorts),
		`from inside the guest, of the host's (CID 2) vsock ports 1 to 65535 every one that answered has an allowed owner ` +
			`(${owned.map((o) => `${o.port} ${o.owner ?? o.why ?? "not allowed"}`).join(", ")}; systemd-detect-virt ` +
			`${vsock.virt ?? "unread"}): 5250 is this run's bridge, LXD's own CID-2 listener is one port whatever its number, 22 and 8443 only on ` +
			"a VM; every other port was refused at once",
	);
	const detached = s.detached ?? {};
	const d = unitOf(detached.commits, "p4/detached.txt");
	const dAt = Number(d?.commit?.createdAtMs);
	check(
		"detached",
		d && !(d.credits?.length > 0) && !(d.commit.credits?.length > 0) && d.commit.actorKind === "staff_agent" &&
			d.commit.actorId === STAFF.alice && d.commit.requesterId === OWNER && d.commit.viewKind === "test_machine" &&
			d.commit.viewId === boot.view?.id && d.commit.runId === credit.runId &&
			detached.receipt?.exitCode === 0 && /^started$/m.test(detached.receipt.output ?? "") && detached.go === 0 &&
			Number.isFinite(detached.endedAtMs) && Number.isFinite(detached.closedAt) && dAt > detached.endedAtMs &&
			dAt > detached.closedAt && dAt >= detached.goAt && same(detached.running, []) && same(detached.unclosed, []),
		"a writer a command left running wrote after the command's end was recorded and every window closed: the commit " +
			"names the starter (Alice's agent, her run, M) and credits no command",
	);
	const loop = s.loop ?? {};
	const unc = (loop.clock?.uncertaintyMs ?? Number.NaN) + 50;
	const loopCommits = loop.commits ?? [];
	const ticks = loop.ticks ?? [];
	// A tick's change, committed first at `delay` after it was written (the guest's time, on the host's clock).
	const ticked = ticks.map((t) => {
		const first = loopCommits.map((c) => c.createdAtMs).filter((c) => c >= t.at - unc).sort((x, y) => x - y)[0];
		return { ...t, delay: first - t.at };
	});
	const quietTicks = ticked.filter((t) => t.at >= loop.quiet?.fromAt && t.at <= loop.quiet?.toAt - 4000);
	const seqs = new Set(loopCommits.map((c) => String(c.seq)));
	const readHit = (loop.reads ?? []).find((r) => r.hit)?.hit;
	check(
		"loop",
		Number.isFinite(unc) && ticks.length >= 4 && ticks.every((t, i) => t.n === i + 1) && ticked.every((t) => t.delay <= 10000) &&
			quietTicks.length >= 2 &&
			quietTicks.every((t) => t.delay >= QUIET_MS - 500 - unc && t.delay <= QUIET_MS + 6000 + unc) &&
			loop.quiet?.boundaries === 0 && loopCommits.length > 0 && loopCommits.every((c) => same(c.credits, [loop.commandId])) &&
			readHit?.outcome === "saved" && seqs.has(String(readHit.seq)) &&
			loop.cancel?.report?.outcome === "saved" && seqs.has(String(loop.cancel.report.seq)) &&
			loop.final?.state === "cancelled" && loop.last?.last === true && loop.last.n === ticks.length + 1,
		"L wrote under /company every 10 s: with no boundary asked, each change was committed by the quiet publish about 2 s " +
			"later; a read right after a write published it at the read's boundary; the cancel published L's last change; " +
			"every change credits L",
	);
	check(
		"stopClosed",
		stop.outcome?.state === "done" && stop.finalBoundary?.final?.includes(stop.viewId) && stop.restarted === true &&
			stop.view?.state === "closed" && stop.view?.closedAt && /stopped/i.test(stop.instanceStatus ?? ""),
		"the stop ran the final boundary, closed the view in SQL, powered the VM off and said restarted",
	);
	const sl = stop.loop ?? {};
	const sUnc = (sl.clock?.uncertaintyMs ?? Number.NaN) + 50;
	const writtenAt = sl.last?.t - (sl.clock?.offsetMs ?? Number.NaN);
	const finalSaved = (sl.reports ?? []).filter((r) => r.outcome === "saved" && r.final?.includes(stop.viewId)).at(-1);
	check(
		"stopWhileRunning",
		sl.last?.last === true && Number.isFinite(writtenAt) && Number.isFinite(sUnc) && finalSaved && finalSaved.seq != null &&
			finalSaved.at >= writtenAt - sUnc && finalSaved.at <= writtenAt + QUIET_MS + sUnc &&
			Number.isFinite(sl.powerOffAt) && finalSaved.answeredAt <= sl.powerOffAt,
		"S wrote while the machine stopped: its last change, made less than the quiet period before the boot's folder " +
			"ended, was saved by the final boundary before the power-off, and the next boot reads it",
	);
	check(
		"secondBoot",
		wake.mounted === true && wake.bootId && wake.bootId !== stop.bootId && wake.view?.id && wake.view.id !== stop.viewId &&
			wake.view.state === "open" && wake.receipt?.exitCode === 0 && wake.receipt?.output?.includes("a"),
		"a second start booted anew with a new view, and the folder still reads",
	);
	check(
		"endedRefused",
		k.row?.state === "lost" && k.row?.endedAt && /MACHINE_COMMAND_ENDED/.test(k.resend ?? "") &&
			/command_ended/.test(JSON.stringify(k.report ?? null)) && k.entries === 0 && refusals.m?.entries === 1 &&
			same(unitOf(refusals.commits, "p4/m.txt")?.credits, [refusals.m?.commandId]),
		"a command ended in SQL is refused again at the gateway and its write is refused command_ended at the boundary",
	);
	const intruder = refusals.intruder ?? {};
	// Refused for who it is: the service found the second machine and said VIEW_REFUSED to every open of this view, and the
	// guest's folder program stopped for good (closed). Unavailable, busy or no answer is not a refusal.
	check(
		"otherMachineRefused",
		intruder.viewId && intruder.viewId === wake.view?.id && intruder.answer?.schema === "qorpera.machine-guest-folder/v1" &&
			intruder.answer.viewId === intruder.viewId && intruder.answer.mount === "closed" && intruder.mount === "closed" &&
			intruder.opens?.length > 0 &&
			intruder.opens.every(
				(o) => o.viewId === intruder.viewId && o.machine === intruder.name && o.lookup === "found" && o.ok === false &&
					o.code === "VIEW_REFUSED",
			) &&
			refusals.stillReads?.exitCode === 0 && refusals.stillReads?.output?.includes("a"),
		"a second machine in the project, with this view's hand-over, was refused the view (VIEW_REFUSED) by the service " +
			"and its folder program closed; the machine still reads",
	);
	const bare = s.noRootRead ?? {};
	const refusedWhy = (f) =>
		f?.company === "none" && typeof f.why === "string" && (f.why === WORDS.refused || f.why.startsWith(`${WORDS.refused}: `));
	const lineIn = (r, line) => new RegExp(`^${line}$`, "m").test(r?.output ?? "");
	check(
		"noRootRead",
		bare.revoked?.count > 0 && bare.readsRoot === false && bare.outcome?.folder === "FOLDER_NONE:REFUSED" &&
			refusedWhy(bare.look?.start?.companyFolder) && refusedWhy(bare.look?.receipt?.companyFolder) &&
			bare.look.receipt.exitCode === 0 && lineIn(bare.look.receipt, "no-company") && lineIn(bare.look.receipt, "entries 0") &&
			same(bare.views, []) && Boolean(bare.placement?.folderUncheckedAt) &&
			(bare.openFailures ?? []).some(
				(f) => f.code === "42501" && /Folder view needs the company-wide view/.test(f.message) && f.details == null,
			),
		"a machine started by a run whose agent does not read the root: the core refused its open, it has no /company, and " +
			"its receipts say company none with the refusal's why",
	);
	const rev = s.reverse ?? {};
	check(
		"reverse",
		rev.install?.exitCode === 0 && lineIn(rev.install, "marker") && lineIn(rev.install, "installed") && rev.restored > 0 &&
			rev.readsRoot === true && rev.stopped?.state === "done" && rev.retired?.folder === "FOLDER_RETIRED:UNCHECKED" &&
			rev.retired.placementId === bare.outcome?.placementId && rev.old?.id === rev.retired.placementId &&
			Boolean(rev.old.retiredAt) && rev.old.folderRetireReason === "unchecked" &&
			(rev.openFailures ?? []).some((f) => /used without the folder check/.test(f.message) && f.details === NEW_DISK) &&
			rev.mounted?.folder === MOUNTED && rev.mounted.placementId !== rev.old.id && rev.placement?.id === rev.mounted.placementId &&
			rev.placement.schema === V2 && rev.look?.receipt?.exitCode === 0 && lineIn(rev.look.receipt, "company-mounted") &&
			lineIn(rev.look.receipt, "no-unit") && lineIn(rev.look.receipt, "no-marker") &&
			rev.look.receipt.output.includes(SEED.trim().split("\n").at(-1)) && rev.look.receipt.companyFolder?.company === "mounted",
		"a boot-time service installed on that machine without the root read: once the starter reads the root again, the " +
			"next boot's open was refused (unchecked disk), the placement retired, and the machine started on a new disk with " +
			"/company and without the service or its marker",
	);
	const narrow = s.narrowed ?? {};
	const carol = narrow.carol ?? {};
	const narrowOld = narrow.mounted?.placementId;
	const lostReason = narrow.aLongRow?.folderLostReason;
	const endedFolder = narrow.ended?.receipt?.companyFolder;
	const endedLater = narrow.aliceAfter?.refused;
	check(
		"narrowed",
		narrow.mounted?.folder === MOUNTED && narrow.aliceBefore?.receipt?.companyFolder?.company === "mounted" &&
			narrow.revoked?.count > 0 && narrow.readsRoot === false && Boolean(carol.run?.refused) && !carol.run.receipt &&
			Boolean(carol.read?.refused) && Boolean(carol.cancel?.refused) &&
			(narrow.carolFailures ?? []).filter((f) => f.code === "42501" && /Machine needs the company-wide view/.test(f.message))
				.length >= 3 &&
			Boolean(narrow.aliceDuring?.receipt) && narrow.viewClosed?.folder === "FOLDER_RESTART:VIEW_CLOSED" &&
			endedFolder?.company === "none" && endedFolder.why === WORDS.endedViewClosed && endedFolder.heldBack === WORDS.heldEnded &&
			narrow.retired?.folder === "FOLDER_RETIRED:STARTER" && narrow.retired.placementId === narrowOld &&
			narrow.old?.id === narrowOld && narrow.old.folderRetireReason === "starter" && Boolean(narrow.old.retiredAt) &&
			(narrow.openFailures ?? []).some((f) => /company-wide view/.test(f.message) && f.details === NEW_DISK) &&
			narrow.restored > 0 && narrow.readsRootAgain === true && narrow.newMounted?.folder === MOUNTED &&
			narrow.newMounted.placementId !== narrowOld && narrow.aLongRow?.state === "lost" &&
			["restart_view_closed", "moved_starter"].includes(lostReason) && endedLater?.code === "MACHINE_COMMAND_ENDED" &&
			endedLater.folderLost === lostReason && typeof endedLater.lost === "string" && endedLater.lost.length > 0 &&
			(lostReason !== "restart_view_closed" || endedLater.lost === WORDS.lostViewClosed) &&
			narrow.look?.receipt?.exitCode === 0 &&
			lineIn(narrow.look.receipt, "company-mounted") && narrow.look.receipt.companyFolder?.company === "mounted",
		"the starter lost the root read while the machine ran with /company: Carol's run was refused every command (42501), " +
			"the core closed the view and the host restarted the guest (company none, heldBack), the refused open retired the " +
			"placement, and the machine started on a new disk; the boot's command is refused ended with the folder's lost",
	);
	const deadlocks = deadlocksIn(evidence);
	check(
		"serviceClean",
		!evidence.error && !(evidence.cleanupErrors?.length > 0) && evidence.service?.bridgeExit === null &&
			!(evidence.service?.passErrors?.length > 0) && !evidence.service?.outcomes?.some((o) => o.state === "failed") &&
			deadlocks.length === 0,
		"no step failed, no host pass failed or threw, no SQL call deadlocked, the folder bridge ran to the end, and " +
			"everything this run made in-process closed" +
			(deadlocks.length > 0
				? `; deadlocks: ${deadlocks.map((d) => `t ${d.t} ${d.function} (${d.in.join(" in ") || "?"}) on ${d.lock ? `${d.lock.relation} ${d.lock.tuple}` : "?"}`).join("; ")}`
				: ""),
	);
	check("noSecretsInEvidence", leaks.length === 0, "the record holds no holder token, view pass or service token");
	return checks;
}

/** One database through psql: a sync query for the checks, and an async session per call for the code it drives. */
class Database {
	constructor(cluster, name) {
		this.cluster = cluster;
		this.name = name;
		this.calls = {};
		this.failures = [];
	}
	query(sql) {
		return this.cluster.psql(this.name, sql, ["-qAt"]).trim();
	}
	json(sql) {
		const out = this.query(sql);
		return out ? JSON.parse(out) : null;
	}
	/** One psql session for `sql`; its error throws with psql's stderr. */
	session(sql) {
		const child = this.cluster.spawnPsql(this.name, ["-qAt"]);
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			err += d;
		});
		child.stdin.end(sql);
		return new Promise((done, fail) => {
			child.on("error", fail);
			child.on("close", (code) => (code === 0 ? done(out.trim()) : fail(new Error(err.trim() || `psql exit ${code}`))));
		});
	}
	/** `select to_jsonb(public.<method>(p_a => …))` with the given claims, in one transaction. */
	async rpc(method, args, claims = SERVICE) {
		assert(/^qorpera_[a-z0-9_]+$/.test(method));
		const parameters = Object.entries(args).map(([name, value]) => {
			assert(/^p_[a-z][a-z0-9_]*$/.test(name));
			return `${name}=>${literal(value)}`;
		});
		this.calls[method] = (this.calls[method] ?? 0) + 1;
		const out = await this.session(`\\set VERBOSITY verbose
begin;
select set_config('request.jwt.claims', ${literal(JSON.stringify(claims))}, true) \\g /dev/null
select to_jsonb(public.${method}(${parameters.join(",")}));
commit;
`);
		return out ? JSON.parse(out) : null;
	}
	/** An expression with a run's binding as 628's helpers read it. */
	async asRun(binding, expression) {
		const out = await this.session(`\\set VERBOSITY verbose
begin;
select set_config('request.jwt.claims', ${literal(JSON.stringify(SERVICE))}, true) \\g /dev/null
select set_config('qorpera_test.base_binding', ${literal(JSON.stringify(binding))}, true) \\g /dev/null
select to_jsonb(${expression});
commit;
`);
		return out ? JSON.parse(out) : null;
	}
}

/** PostgREST in front of the database for the clients run as built (the folder core's transport, the object
 * authority's and the executor control's fetch): a function as the service role, and the folder clocks' read. */
function postgrest(db) {
	const answer = async (method, url, body) => {
		const rpc = /^\/rest\/v1\/rpc\/(qorpera_[a-z0-9_]+)$/.exec(url.pathname);
		try {
			if (method === "POST" && rpc) return { status: 200, value: await db.rpc(rpc[1], JSON.parse(body ?? "{}")) };
			if (method === "GET" && url.pathname === "/rest/v1/qorpera_folder_clocks") {
				assert.equal(url.searchParams.get("select"), "environment_id,last_seq");
				const ids = /^in\.\(([0-9a-f,-]+)\)$/.exec(url.searchParams.get("environment_id") ?? "");
				assert(ids, "the clocks are read by environment");
				const out = await db.session(`select coalesce(jsonb_agg(jsonb_build_object('environment_id', environment_id,
					'last_seq', last_seq)), '[]') from public.qorpera_folder_clocks
					where environment_id = any(${literal(`{${ids[1]}}`)}::uuid[]);`);
				return { status: 200, value: JSON.parse(out) };
			}
			return { status: 404, value: { code: "PGRST202", details: null, hint: null, message: `No ${method} ${url.pathname}` } };
		} catch (error) {
			const failed = postgrestFailure(error?.message ?? "");
			if (!failed) throw error;
			if (db.failures.length < 2000) {
				const why = sqlError(error?.message ?? "");
				db.failures.push({ t: elapsed(), method: rpc?.[1] ?? url.pathname, code: failed.value.code, details: failed.value.details,
					message: failed.value.message.slice(0, 300), in: why?.functions ?? [], lock: why?.lock ?? null,
					...(failed.value.code === "40P01" ? { waits: why?.details ?? null } : {}) });
			}
			return failed;
		}
	};
	return {
		transport: async (url, request) => {
			const { status, value } = await answer(request.method, url, request.body);
			return { status, body: Buffer.from(JSON.stringify(value)) };
		},
		fetch: async (input, init = {}) => {
			const { status, value } = await answer(init.method ?? "GET", new URL(String(input)), init.body);
			return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
		},
	};
}

const started = Date.now();
const elapsed = () => Math.round((Date.now() - started) / 100) / 10;
const say = (line) => process.stdout.write(`P4 ${elapsed()}s ${line}\n`);

/** The node's coding NAS, stood in: its control root is a directory of the work directory (the host keeps its
 * journals there), and nothing is mounted. */
const NAS_STAND_IN = `export function createCodingNasStorage(policy) {
	const controlPath = \`\${policy.rootPath}/control\`;
	return { controlPath, async assertControl() {}, async prepareControl() { return controlPath; }, async prepare() {}, async assert() {} };
}`;

/** The code the proof drives, as built. */
async function bundle(work) {
	const modulePath = join(work, "p4-code.mjs");
	await build({
		absWorkingDir: repositoryRoot,
		stdin: {
			resolveDir: repositoryRoot,
			contents: [
				'export {createControlServer} from "./packages/object-gateway/src/folder-service/control.ts";',
				'export {createFolderServer} from "./packages/object-gateway/src/folder-service/server.ts";',
				'export {FolderService} from "./packages/object-gateway/src/folder-service/service.ts";',
				'export {FolderStaging, GatewayUploads} from "./packages/object-gateway/src/folder-service/staging.ts";',
				'export {MountGrants} from "./packages/object-gateway/src/folder-service/mounts.ts";',
				'export {NasObjects} from "./packages/object-gateway/src/folder-service/objects.ts";',
				'export {SupabaseFolderCore} from "./packages/object-gateway/src/folder-service/core.ts";',
				'export {FileSystemObjectStore} from "./packages/object-gateway/src/object-store.ts";',
				'export {PlatformFolderWriter} from "./packages/object-gateway/src/platform-folder-writer.ts";',
				'export {createObjectGatewayHandler} from "./packages/object-gateway/src/service.ts";',
				'export {SupabaseObjectAuthority} from "./packages/object-gateway/src/supabase-authority.ts";',
				'export {LxdCompanyMachineHost} from "./packages/runner-orchestrator/src/company-machine-host.ts";',
				'export {UnixFolderControl} from "./packages/runner-orchestrator/src/folder-control.ts";',
				'export {LxdUnixClient} from "./packages/runner-orchestrator/src/lxd-client.ts";',
				'export {lxdCompanyMachineName} from "./packages/runner-orchestrator/src/company-machine.ts";',
				'export {CodingExecutorHttpControl} from "./deploy/coding-worker/control.ts";',
				'export {MachineCommandRouter} from "./deploy/coding-worker/machine-command-routing.ts";',
				'export {authorizeMachineCommand} from "./deploy/coding-worker/machine-command-authority.ts";',
				'export {proveNativeBinding} from "./deploy/coding-worker/command-authority.ts";',
				'export {HttpCloudCodingCommandService} from "./packages/runtime/src/cloud-coding-command-http.ts";',
				'export {CLOUD_MACHINE_TOOL_VERSION, createHttpCloudMachineCommandGateway} from "./packages/runtime/src/cloud-machine-command-http.ts";',
				'export {cloudNativeToolOperationEnvelope} from "./packages/runtime/src/cloud-native-tool-operations.ts";',
				'export {parseCloudNativeToolAuthority} from "./packages/runtime/src/cloud-native-tool-authority.ts";',
				'export {CLOUD_MACHINE_FOLDER_LOST} from "./packages/contracts/src/cloud-machine.ts";',
			].join("\n"),
		},
		plugins: [
			{
				name: "p4-coding-nas-stand-in",
				setup(builder) {
					builder.onResolve({ filter: /^\.\/coding-storage\.ts$/ }, (args) =>
						args.importer.endsWith("company-machine-host.ts") ? { path: "coding-storage", namespace: "p4-nas" } : undefined,
					);
					builder.onLoad({ filter: /.*/, namespace: "p4-nas" }, () => ({ contents: NAS_STAND_IN, loader: "js" }));
				},
			},
		],
		platform: "node",
		format: "esm",
		target: "node22",
		bundle: true,
		outfile: modulePath,
		logLevel: "silent",
	});
	return import(pathToFileURL(modulePath).href);
}

async function until(label, probe, { timeoutMs, everyMs = 2000, signal }) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		signal?.throwIfAborted();
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`P4_TIMEOUT: ${label}`);
		await sleep(everyMs, undefined, { signal });
	}
}

/** The lxc CLI in the claimed project. Not synchronous: a VM's init takes long enough that a blocked event loop would
 * time out the executor's control calls and the folder service's timers. */
function lxc(project, args, { timeoutMs = 600_000 } = {}) {
	return new Promise((answered) => {
		const child = spawn("lxc", ["--force-local", "--project", project, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (d) => {
			stdout += d;
		});
		child.stderr.setEncoding("utf8").on("data", (d) => {
			stderr = (stderr + d).slice(-2000);
		});
		child.on("error", (error) => answered({ status: null, stdout, stderr: String(error.message).slice(0, 2000) }));
		child.on("close", (status) => answered({ status, stdout, stderr }));
	});
}

/** A receipt as the evidence keeps it, with the company folder's report (6e-2a). */
const receiptOf = (r) =>
	r
		? { state: r.state, exitCode: r.exitCode, output: r.output, totalBytes: r.log?.totalBytes, companyFolder: r.companyFolder ?? null }
		: null;

/** A guest's wall clock against this host's, from the fastest of a few `date` calls over `lxc exec`: `offsetMs` is the
 * guest's time minus the host's, within `uncertaintyMs`. */
async function guestClock(project, name) {
	let best = null;
	for (let i = 0; i < 5; i++) {
		const before = Date.now();
		const said = await lxc(project, ["exec", name, "--", "date", "+%s%3N"], { timeoutMs: 30_000 });
		const after = Date.now();
		const guest = Number(said.stdout.trim());
		if (said.status !== 0 || !Number.isSafeInteger(guest)) continue;
		const sample = { offsetMs: guest - Math.round((before + after) / 2), uncertaintyMs: Math.ceil((after - before) / 2) };
		if (!best || sample.uncertaintyMs < best.uncertaintyMs) best = sample;
	}
	if (!best) throw new Error(`P4: no clock from ${name}`);
	return best;
}

/** One `ss -H -l -p --vsock` line (whitespace normalized): the CID it is bound to (`*` for any), its port, and the
 * processes holding it. */
export function parseVsockListener(line) {
	const local = /^(\*|\d+):(\d+)$/.exec(line.split(" ")[4] ?? "");
	const processes = [...line.matchAll(/\("([^"]*)",pid=(\d+),fd=\d+\)/g)].map(([, name, pid]) => ({ name, pid: Number(pid) }));
	return { cid: local ? local[1] : null, port: local ? Number(local[2]) : null, processes };
}

/** systemd's vsock socket units from `systemctl list-sockets --all --no-legend --full`: port -> unit. */
export function parseSocketUnits(text) {
	const units = {};
	for (const line of String(text).split("\n")) {
		const [listen, unit] = line.trim().split(/\s+/);
		const vsock = /^vsock:[^:]*:(\d+)$/.exec(listen ?? "");
		if (vsock && unit?.endsWith(".socket")) units[vsock[1]] = unit;
	}
	return units;
}

/** A read-only command's exit status and stdout. */
function readOnly(command, args) {
	return new Promise((done) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
		let out = "";
		child.stdout.setEncoding("utf8").on("data", (d) => {
			out += d;
		});
		child.on("error", (error) => done({ status: null, out: "", error: error.message }));
		child.on("close", (status) => done({ status, out }));
	});
}

/** This test machine's vsock listeners with their owners (read-only): each `ss -l -p --vsock` line's bound CID, port and
 * processes (name, pid, executable), the systemd socket unit on that port, and what `systemd-detect-virt --vm` says. */
async function vsockOwners() {
	const [ss, virt, sockets] = await Promise.all([
		readOnly("ss", ["-H", "-l", "-p", "--vsock"]),
		readOnly("systemd-detect-virt", ["--vm"]),
		readOnly("systemctl", ["list-sockets", "--all", "--no-legend", "--full"]),
	]);
	const lines = ss.out.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 50);
	const units = parseSocketUnits(sockets.out);
	const exe = (pid) =>
		readOnly("readlink", [`/proc/${pid}/exe`]).then((said) => (said.status === 0 ? said.out.trim() : null));
	const listeners = await Promise.all(
		lines.map(async (line) => {
			const listener = parseVsockListener(line);
			for (const p of listener.processes) p.exe = await exe(p.pid);
			return { ...listener, unit: listener.port === null ? null : (units[listener.port] ?? null) };
		}),
	);
	return {
		virt: virt.out.trim() || null,
		virtExit: virt.status,
		lines,
		listeners,
		ssError: ss.error ?? (ss.status === 0 ? null : `ss exited ${ss.status}`),
	};
}

/** The probe a guest runs: every vsock port of the host (CID 2), and which answer. A refused port is reset at once. */
const VSOCK_PROBE = `python3 - <<'PY'
import errno, json, socket
from concurrent.futures import ThreadPoolExecutor
def probe(port):
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    s.settimeout(3)
    try:
        s.connect((2, port))
        return port, "answered"
    except socket.timeout:
        return port, "timeout"
    except OSError as e:
        return port, errno.errorcode.get(e.errno, str(e.errno))
    finally:
        s.close()
with ThreadPoolExecutor(64) as pool:
    said = list(pool.map(probe, range(1, 65536)))
errnos = {}
for _, how in said:
    if how not in ("answered", "timeout"):
        errnos[how] = errnos.get(how, 0) + 1
timeouts = [port for port, how in said if how == "timeout"]
print(json.dumps({"scanned": len(said), "answered": [port for port, how in said if how == "answered"],
    "timeoutCount": len(timeouts), "timeouts": timeouts[:50], "errnos": errnos}))
PY`;

/** L: a write under /company at every 10 s of the guest's clock (a counter and the guest's time in ms), its last on
 * TERM (a cancel or a stop), at most 60. */
const LOOP_COMMAND = [
	"f=/company/p4/loop.txt; n=0",
	`trap 'n=$((n+1)); t=$(date +%s%3N); echo "$n last $t" > $f; echo "last $n $t"; exit 0' TERM`,
	"while [ $n -lt 60 ]; do",
	"ms=$(( $(date +%s%3N) % 10000 )); w=$(( 10000 - ms ))",
	`sleep "$((w / 1000)).$(printf %03d $((w % 1000)))" & wait $!`,
	`n=$((n+1)); t=$(date +%s%3N); echo "$n $t" > $f; echo "tick $n $t"`,
	"done",
].join("\n");

/** S: a write under /company every half second until it is stopped, its last on TERM. */
const STOP_LOOP_COMMAND = [
	"f=/company/p4/stop-loop.txt; n=0",
	`trap 'n=$((n+1)); echo "$n last $(date +%s%3N)" > $f; exit 0' TERM`,
	`while :; do n=$((n+1)); echo "$n $(date +%s%3N)" > $f; sleep 0.5 & wait $!; done`,
].join("\n");

async function prove(options, evidence, cleanups, secrets) {
	const signal = AbortSignal.timeout(150 * 60_000);
	const { project, pool, image, work } = options;
	const steps = evidence.steps;
	const code = await bundle(work);
	say("bundled the code under proof");

	// The runs' lease tokens: each holder proves its run's job lease with one (qorpera_native_binding_proven).
	const runs = {};
	for (const name of ["alice", "bob", "carol"]) {
		runs[name] = { token: token() };
		secrets[`holder:${name}`] = runs[name].token;
	}
	const nodeSha = sha256hex(`p4-test-machine-node:${project}`);
	const policy = {
		providerId: PROVIDER,
		providerPolicySha256: "f".repeat(64),
		project,
		imageFingerprint: image,
		bootstrapSha256: options.bootstrapSha256,
		storagePool: pool,
		network: "qagent0",
	};

	const database = await hostedDatabase(DATABASE);
	cleanups.push(async () => database.close());
	const db = new Database(database.cluster, DATABASE);
	const expanded = expandTestFixture("628_runtime_company_machines.test.sql", (name) =>
		readFileSync(join(repositoryRoot, "supabase", "tests", name), "utf8"),
	);
	const fixture = db.query(
		fixtureSql(expanded, {
			project,
			nodeSha,
			policy,
			leaseSha: Object.fromEntries(Object.entries(runs).map(([name, run]) => [name, sha256hex(run.token)])),
		}),
	);
	for (const [, name, value] of fixture.matchAll(/^@@p4-([a-z]+) (.*)$/gm)) runs[name].binding = JSON.parse(value);
	for (const name of Object.keys(runs)) assert(runs[name].binding?.runId, `P4: no binding for ${name}`);
	evidence.runs = Object.fromEntries(
		Object.entries(runs).map(([name, run]) => [name, { runId: run.binding.runId, jobId: run.binding.jobId, staffAgentId: STAFF[name] }]),
	);
	say(`fixture: company ${ENV}, runs ${Object.values(runs).map((r) => r.binding.runId).join(", ")}`);

	// The node's observation in two transactions, as the real observer makes it (628's mc_observe in one deadlocks with
	// the host's reserve): the inventory context, then the observation with it. One at a time, as the node has one
	// observer, so the boot's does not change the context under the keeper's. `step` names the call that failed.
	let observed = Promise.resolve();
	const observeNode = (step = {}) => {
		observed = observed.catch(() => undefined).then(async () => {
			step.calling = "qorpera_runtime_node_inventory_context";
			const context = await db.asRun(runs.alice.binding, `public.qorpera_runtime_node_inventory_context(${literal(NODE_ID)})`);
			step.calling = "p4.mc_observe_with";
			await db.asRun(runs.alice.binding,
				`p4.mc_observe_with(${literal(NODE_ID)}, ${literal(nodeSha)}, 16000, 68719476736, ${literal(context)})`);
		});
		return observed;
	};
	// The runs stay live: their jobs' and native leases' renewals, the runners' session rotation, the node's observation.
	const keeper = { renewals: 0, errors: [], stop: false };
	for (const run of Object.values(runs)) run.session = "2".repeat(64);
	let rotated = Date.now();
	// A failed call, with the function it called and, for a database error, its SQLSTATE, waits, lock and functions.
	const failedKeep = (name, error) => {
		if (keeper.errors.length >= 50) return;
		const why = sqlError(error?.message ?? "");
		keeper.errors.push(why
			? { t: elapsed(), function: name, code: why.code, message: why.message.slice(0, 200), waits: why.details, lock: why.lock, in: why.functions }
			: { t: elapsed(), function: name, error: String(error?.message ?? error).slice(0, 400) });
	};
	const keep = async () => {
		const rotate = Date.now() - rotated > 5 * 60_000;
		if (rotate) rotated = Date.now();
		for (const run of Object.values(runs)) {
			const b = run.binding;
			const lease = sha256hex(run.token);
			let calling = null;
			try {
				if (rotate) {
					const next = randomBytes(32).toString("hex");
					calling = "qorpera_heartbeat_runner";
					await db.rpc("qorpera_heartbeat_runner", {
						p_runner_id: b.runnerId, p_current_token_sha256: run.session, p_next_token_sha256: next, p_renewal_id: randomUUID(),
					});
					run.session = next;
				}
				calling = "qorpera_renew_runner_job";
				await db.rpc("qorpera_renew_runner_job", {
					p_runner_id: b.runnerId, p_session_token_sha256: run.session, p_job_id: b.jobId, p_lease_token_sha256: lease,
				});
				calling = "qorpera_renew_native_provider_connection_lease";
				await db.rpc("qorpera_renew_native_provider_connection_lease", {
					p_lease_id: b.leaseId, p_runner_id: b.runnerId, p_session_token_sha256: run.session, p_job_id: b.jobId,
					p_lease_token_sha256: lease, p_lease_seconds: 120,
				});
				keeper.renewals++;
			} catch (error) {
				failedKeep(calling, error);
			}
		}
		const observing = {};
		try {
			await observeNode(observing);
		} catch (error) {
			failedKeep(observing.calling, error);
		}
	};
	const keeping = (async () => {
		while (!keeper.stop) {
			await keep();
			await sleep(20_000).catch(() => undefined);
		}
	})();
	cleanups.push(async () => {
		keeper.stop = true;
		await keeping;
	});
	evidence.keeper = keeper;

	// The object gateway (its folder service route stages the machine's bytes) and the company file the machine reads.
	const stand = postgrest(db);
	const store = new code.FileSystemObjectStore(join(work, "objects"));
	const replication = {
		async uploadWithAuthority(profile, hash, bytes, callbacks) {
			await callbacks.authorize();
			const result = await store.put(profile, hash, bytes);
			await callbacks.confirm();
			return result;
		},
	};
	const authority = new code.SupabaseObjectAuthority({
		projectUrl: ORIGIN, publishableKey: STAND_IN, secretKey: STAND_IN, fetch: stand.fetch,
	});
	secrets.objectsToken = token();
	secrets.controlToken = token();
	const gatewayServer = createServer(
		code.createObjectGatewayHandler({
			store, authority, controlToken: secrets.controlToken, replication,
			folderServiceObjects: { token: secrets.objectsToken, authority },
		}),
	);
	await new Promise((listening, failed) => {
		gatewayServer.once("error", failed);
		gatewayServer.listen(0, "127.0.0.1", listening);
	});
	cleanups.push(() => new Promise((closed) => gatewayServer.close(() => closed())));
	const member = { kind: "member", userId: OWNER };
	const writer = new code.PlatformFolderWriter({ authority: { publisher: (m, a) => db.rpc(m, a) }, actor: member, store, replication });
	const seedFile = await writer.stage(ENV, new TextEncoder().encode(SEED), { mediaType: "text/markdown", executable: false }, signal);
	const seeded = await db.rpc("qorpera_folder_commit", {
		p_environment_id: ENV, p_actor: member, p_operation_key: `member:${OWNER}:p4-seed-001`,
		p_units: [{ op: "mkdir", path: "p4" }, { op: "write", path: "p4/seed.md", file: seedFile }],
	});
	assert(seeded?.units?.every((u) => u.outcome === "saved"), `P4: the seed did not save: ${JSON.stringify(seeded)}`);
	say(`seeded p4/seed.md at seq ${seeded.seq}`);

	// The node folder service: its core over the stand-in, its control socket for the executor (root here) and its
	// folder socket behind the folder program's vsock bridge. Every open it is asked is recorded (never its pass).
	const opens = [];
	const serviceLog = [];
	const log = (line) => {
		serviceLog.push(`${elapsed()} ${line}`);
		if (serviceLog.length > 400) serviceLog.shift();
	};
	const core = new code.SupabaseFolderCore({ projectUrl: ORIGIN, secretKey: STAND_IN, transport: stand.transport });
	const objects = new code.NasObjects({ root: join(work, "objects"), cacheBytes: 64 * 1024 * 1024 });
	const uploads = new code.GatewayUploads({ url: `http://127.0.0.1:${gatewayServer.address().port}/`, token: secrets.objectsToken });
	const service = new (class extends code.FolderService {
		async open(hello, bridge) {
			const entry = { t: elapsed(), viewId: hello.viewId, role: hello.role, cid: bridge.cid, lookup: bridge.lookup,
				machine: bridge.machine?.name ?? null };
			opens.push(entry);
			try {
				const handle = await super.open(hello, bridge);
				entry.ok = true;
				return handle;
			} catch (error) {
				entry.ok = false;
				entry.code = error?.code ?? String(error?.message ?? error).slice(0, 200);
				throw error;
			}
		}
	})({
		core, objects, grants: new code.MountGrants([], [], [], [], [project]),
		staging: new code.FolderStaging(core, uploads, objects), log,
	});
	const controlPath = join(work, "control.sock");
	const folderPath = join(work, "folder.sock");
	const controlServer = code.createControlServer({ target: service, path: controlPath, executorUid: 0, log });
	const folderServer = code.createFolderServer(service, log);
	for (const [server, path] of [[controlServer, controlPath], [folderServer, folderPath]]) {
		await new Promise((listening, failed) => {
			server.once("error", failed);
			server.listen(path, listening);
		});
		chmodSync(path, 0o600);
		cleanups.push(() => new Promise((closed) => server.close(() => closed())));
	}
	service.start();
	cleanups.push(async () => service.stop());
	const bridge = spawn(
		options.folderBinary,
		["bridge", "--service", `unix:${folderPath}`, "--listen", "vsock:any:5250", "--lxd-socket", "/var/snap/lxd/common/lxd/unix.socket"],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const bridgeLog = [];
	let stopping = false;
	evidence.service = { bridgeExit: null };
	for (const stream of [bridge.stdout, bridge.stderr])
		stream.on("data", (d) => {
			for (const line of String(d).split("\n").filter(Boolean)) {
				bridgeLog.push(`${elapsed()} ${line.slice(0, 300)}`);
				if (bridgeLog.length > 200) bridgeLog.shift();
			}
		});
	bridge.on("exit", (status, sig) => {
		if (!stopping) evidence.service.bridgeExit = { status, signal: sig };
	});
	cleanups.push(async () => {
		stopping = true;
		if (bridge.exitCode === null && bridge.signalCode === null) {
			bridge.kill("SIGTERM");
			await new Promise((exited) => bridge.once("exit", exited));
		}
	});
	say("folder service and bridge up");

	// The executor's test machine host, with the folder control on the service's socket. While `held`, a boundary or
	// a window's close gets no answer, as when the service does not answer: the output must wait. Each call says what
	// asked it (`by`): a pass, or a gateway's start, read or cancel of a command (`byCommand`).
	const ops = [];
	const tags = new AsyncLocalStorage();
	const inner = new code.UnixFolderControl(controlPath);
	const folder = {
		held: false,
		async op(op, machine, detail, call) {
			const tag = tags.getStore();
			const entry = { t: elapsed(), at: Date.now(), op, machine, ...detail, by: tag?.by ?? null, byCommand: tag?.commandId ?? null };
			ops.push(entry);
			if (folder.held && (op === "boundary" || op === "closeWindow")) {
				entry.answer = "held";
				throw new Error("FOLDER_CONTROL_UNANSWERED");
			}
			try {
				const answer = await call();
				entry.answer = answer ?? "ok";
				entry.answeredAt = Date.now();
				return answer;
			} catch (error) {
				entry.error = error?.code ?? String(error?.message ?? error).slice(0, 200);
				throw error;
			}
		},
		boundary: (machine, final, s) => folder.op("boundary", machine, { final: [...final] }, () => inner.boundary(machine, final, s)),
		restarted: (machine, s) => folder.op("restarted", machine, {}, () => inner.restarted(machine, s)),
		openWindow: (machine, window, s) =>
			folder.op("openWindow", machine, { commandId: window.commandId, runId: window.runId }, () => inner.openWindow(machine, window, s)),
		closeWindow: (machine, commandId, s) =>
			folder.op("closeWindow", machine, { commandId }, () => inner.closeWindow(machine, commandId, s)),
	};
	const journalRoot = join(work, "nas", "control");
	mkdirSync(journalRoot, { recursive: true, mode: 0o700 });
	chmodSync(join(work, "nas"), 0o700);
	chmodSync(journalRoot, 0o700);
	assert.equal(realpathSync(journalRoot), journalRoot);
	const lxd = new code.LxdUnixClient();
	// What the host asked LXD to do to an instance, and when (a power-off is asked at `at`, for the stop's order).
	const lxdOps = [];
	const recordedLxd = new Proxy(lxd, {
		get(target, property) {
			if (property === "submitInstanceOperation")
				return async (project, operation, s) => {
					const entry = { t: elapsed(), at: Date.now(), action: operation?.action ?? null,
						name: operation?.name ?? operation?.request?.name ?? null, force: operation?.force === true };
					if (lxdOps.length < 400) lxdOps.push(entry);
					try {
						const submitted = await target.submitInstanceOperation(project, operation, s);
						entry.submittedAt = Date.now();
						return submitted;
					} catch (error) {
						entry.error = String(error?.message ?? error).slice(0, 200);
						throw error;
					}
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const handovers = [];
	const control = new code.CodingExecutorHttpControl({ supabaseUrl: `${ORIGIN}/`, serviceRoleKey: STAND_IN, fetch: stand.fetch });
	const host = new code.LxdCompanyMachineHost({
		control, owner: EXECUTOR, machineIdSha256: nodeSha, policy,
		client: nicStandIn(recordedLxd, new Map(), keepHandover(handovers, secrets)), journalRoot,
		storagePolicy: {
			schema: "qorpera.coding-nas-policy/v1", mountPoint: join(work, "nas"), source: "192.0.2.1:/p4", serverAddress: "192.0.2.1",
			rootPath: join(work, "nas"),
		},
		helperSha256: options.helperSha256, folder, agentPlug: async () => "0e:51:0a:d2:01:0a",
		// A nested guest can take longer than the host's default 180 s to answer while other VMs boot (run 1: 182–234 s,
		// each started a few passes later); P3's executor test waits 900 s the same way.
		guestReadyTimeoutMs: 900_000,
	});
	const router = new code.MachineCommandRouter({
		owner: EXECUTOR, providerId: PROVIDER, peers: [], control,
		credential: async () => {
			throw new Error("P4_NO_PEERS");
		},
		executeLocal: (request, authority, s) =>
			tags.run({ by: request.action, commandId: request.input.commandId }, () =>
				host.command(
					{ machineId: authority.machineId, placementId: authority.placementId, commandId: request.input.commandId,
						inputSha256: authority.inputSha256, bootId: authority.bootId, runId: authority.runId,
						staffAgentId: authority.staffAgentId, requestedByUserId: authority.requestedByUserId },
					request.action === "start"
						? { action: "start", commandId: request.input.commandId, inputSha256: request.input.inputSha256,
							command: request.input.command, timeoutMs: request.input.timeoutMs }
						: request.action === "read" ? { action: "read", read: request.input } : { action: "cancel", commandId: request.input.commandId },
					s,
				),
			),
	});
	secrets.commandToken = token();
	const commands = new code.HttpCloudCodingCommandService({
		token: secrets.commandToken,
		proveBinding: (binding, holder, s) => code.proveNativeBinding(control, binding, holder, s),
		authorize: async () => {
			throw new Error("P4_NO_CODING_COMMANDS");
		},
		execute: async () => {
			throw new Error("P4_NO_CODING_COMMANDS");
		},
		machines: {
			authorize: (request, s) => code.authorizeMachineCommand(control, request, s),
			execute: (request, s) => router.execute(request, s),
		},
	});
	const port = await commands.start(signal);
	cleanups.push(() => commands.close());
	for (const run of Object.values(runs))
		run.gateway = code.createHttpCloudMachineCommandGateway({
			url: `http://127.0.0.1:${port}/`, token: secrets.commandToken, binding: run.binding,
			holder: () => `job.${run.binding.jobId}.${run.token}`, allowLoopback: true,
		});

	// The executor's pass loop, as its timer runs it. A step may pause it (no pass runs, as between two of the timer's
	// passes, only longer), so that only the call it makes reaches the folder; or ask to hear of an outcome, and have the
	// loop pause right after the pass that said it.
	const outcomes = [];
	const passErrors = [];
	const passes = { paused: false, pauses: [], hooks: [], current: Promise.resolve() };
	let passing = true;
	const pauseNow = (why) => {
		if (!passes.paused) passes.pauses.push({ why, from: elapsed(), fromAt: Date.now() });
		passes.paused = true;
	};
	const pausePasses = async (why) => {
		pauseNow(why);
		await passes.current;
	};
	const resumePasses = () => {
		const last = passes.pauses.at(-1);
		if (passes.paused && last) Object.assign(last, { to: elapsed(), toAt: Date.now() });
		passes.paused = false;
	};
	/** The first pass outcome `match` takes, from the passes after this call; `pause` pauses the loop right after it. */
	const hearOutcome = async (why, match, { pause = false, timeoutMs = 10 * 60_000 } = {}) => {
		const hook = { why, match, pause };
		const heard = new Promise((resolve) => {
			hook.resolve = resolve;
		});
		passes.hooks.push(hook);
		const timer = new AbortController();
		try {
			return await Promise.race([
				heard,
				sleep(timeoutMs, undefined, { signal: AbortSignal.any([signal, timer.signal]) }).then(() => {
					throw new Error(`P4_TIMEOUT: ${why}`);
				}),
			]);
		} finally {
			timer.abort();
			passes.hooks = passes.hooks.filter((h) => h !== hook);
		}
	};
	const passLoop = (async () => {
		while (passing) {
			if (passes.paused) {
				await sleep(200).catch(() => undefined);
				continue;
			}
			let done;
			passes.current = new Promise((resolve) => {
				done = resolve;
			});
			try {
				const said = await tags.run({ by: "pass" }, () => host.pass(signal));
				for (const outcome of said) {
					const last = outcomes.findLast((o) => o.placementId === outcome.placementId);
					const { t: _t, at: _at, ...was } = last ?? {};
					if (!last || !same(was, outcome)) outcomes.push({ t: elapsed(), at: Date.now(), ...outcome });
					if (outcomes.length > 600) outcomes.splice(0, 100);
				}
				for (const hook of [...passes.hooks]) {
					const outcome = said.find((o) => hook.match(o));
					if (!outcome) continue;
					passes.hooks = passes.hooks.filter((h) => h !== hook);
					if (hook.pause) pauseNow(hook.why);
					hook.resolve({ t: elapsed(), at: Date.now(), ...outcome });
				}
			} catch (error) {
				if (passErrors.length < 100) passErrors.push({ t: elapsed(), error: String(error?.message ?? error).slice(0, 300) });
			} finally {
				done();
			}
			if (!passes.paused) await sleep(2000).catch(() => undefined);
		}
	})();
	cleanups.push(async () => {
		passing = false;
		passes.paused = false;
		await passLoop;
	});
	evidence.service = { ...evidence.service, opens, ops, outcomes, passErrors, rpcCalls: db.calls, rpcFailures: db.failures,
		serviceLog, bridgeLog, pauses: passes.pauses, lxdOps };

	// The SQL the evidence reads. A machine is p4 unless said: `p4.id` is its id once made.
	let machineId;
	const p4 = { name: MACHINE, get id() { return machineId; } };
	const views = (id = machineId) =>
		db.json(`select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'state', state, 'bootId', boot_id,
			'placementId', placement_id, 'runId', run_id, 'staffAgentId', staff_agent_id, 'memberUserId', member_user_id,
			'createdAt', created_at, 'closedAt', closed_at, 'closeReason', close_reason) order by created_at), '[]')
			from public.qorpera_folder_views where company_machine_id = ${literal(id)}`);
	const commandRows = (id = machineId) =>
		db.json(`select coalesce(jsonb_agg(jsonb_build_object('id', id, 'runId', run_id, 'staffAgentId', staff_agent_id,
			'placementId', placement_id, 'state', state, 'exitCode', exit_code, 'startedAt', started_at, 'endedAt', ended_at,
			'endedAtMs', (extract(epoch from ended_at) * 1000)::bigint, 'folderLostReason', folder_lost_reason) order by started_at), '[]')
			from public.qorpera_company_machine_commands where machine_id = ${literal(id)}`);
	const commits = () =>
		db.json(`select coalesce(jsonb_agg(jsonb_build_object('seq', c.seq, 'operationKey', c.operation_key,
			'actorKind', c.actor_kind, 'actorId', c.actor_id, 'requesterKind', c.requester_kind, 'requesterId', c.requester_id,
			'runId', c.run_id, 'turnRunId', c.turn_run_id, 'viewId', c.view_id, 'viewKind', c.view_kind,
			'createdAtMs', (extract(epoch from c.created_at) * 1000)::bigint,
			'credits', to_jsonb(c.credits), 'units', (select coalesce(jsonb_agg(jsonb_build_object('op', u ->> 'op', 'path', u ->> 'path',
				'credits', u -> 'credits')), '[]') from jsonb_array_elements(c.units) u)) order by c.seq), '[]')
			from public.qorpera_folder_commits c where c.environment_id = ${literal(ENV)} and c.view_id is not null`);
	/** A machine's placements, oldest first: the binding's schema (v2 has no repository worker), its boots and its end. */
	const placements = (id) =>
		db.json(`select coalesce(jsonb_agg(jsonb_build_object('id', id, 'schema', binding ->> 'schema',
			'repositoryWorkerId', binding ? 'repositoryWorkerId', 'bootId', boot_id, 'runningAt', running_at,
			'retiredAt', retired_at, 'removedAt', removed_at, 'folderUncheckedAt', folder_unchecked_at,
			'folderRetireReason', folder_retire_reason) order by created_at, id), '[]')
			from public.qorpera_company_machine_placements where machine_id = ${literal(id)}`);
	const machineRow = (name) =>
		db.json(`select jsonb_build_object('id', id, 'desiredState', desired_state, 'removedAt', removed_at)
			from public.qorpera_company_machines where name = ${literal(name)} order by created_at desc limit 1`);
	/** Whether a staff agent (with the owner as its member) reads the company folder's root now. */
	const readsRoot = (agent) =>
		db.query(`select public.qorpera_folder_reads_root(f.environment_id, f.profile_id, ${literal(agent)}::uuid, ${literal(OWNER)}::uuid)
			from public.qorpera_company_files f where f.environment_id = ${literal(ENV)}`) === "t";
	/** Takes a staff agent's grants away, as SQL test 516 does (without the triggers that would say so): the root read
	 * with them. Says when, for `restoreRoot`. */
	const revokeRoot = (agent) =>
		db.json(`begin;
			set local session_replication_role = replica;
			with revoked as (update public.qorpera_company_path_grants set revoked_at = clock_timestamp()
				where principal_kind = 'staff_agent' and principal_id = ${literal(agent)} and revoked_at is null returning revoked_at)
			select jsonb_build_object('count', count(*), 'since', min(revoked_at)) from revoked;
			commit;`);
	const restoreRoot = (agent, since) =>
		Number(db.query(`begin;
			set local session_replication_role = replica;
			with restored as (update public.qorpera_company_path_grants set revoked_at = null
				where principal_kind = 'staff_agent' and principal_id = ${literal(agent)} and revoked_at >= ${literal(since)}::timestamptz
				returning 1)
			select count(*) from restored;
			commit;`));
	/** The view-open refusals the folder control got from SQL since index `from` of the failures. */
	const openFailures = (from) => db.failures.slice(from).filter((f) => f.method === "qorpera_folder_view_open");
	const entries = (path) =>
		Number(db.query(`select count(*) from public.qorpera_folder_entries where environment_id = ${literal(ENV)}
			and key_text = public.qorpera_folder_key(${literal(path)}) and kind <> 'claim'`));
	const readPaths = (table, column, id) =>
		db.json(`select coalesce(jsonb_agg(distinct x ->> 'path' order by x ->> 'path'), '[]')
			from public.${table} rec, jsonb_array_elements(rec.reads) x where rec.${column} = ${literal(id)}`);
	const commandRow = (id, mach = p4) => commandRows(mach.id).find((row) => row.id === id);
	/** The first pass outcome since `at` on one of the machine's placements that `match` takes. */
	const folderOutcome = (label, at, mach, match, timeoutMs = 15 * 60_000) =>
		until(label, () => {
			const ids = new Set(placements(mach.id).map((p) => p.id));
			return outcomes.find((o) => o.at >= at && ids.has(o.placementId) && match(o));
		}, { timeoutMs, signal });
	const mountedSince = (at, mach = p4) =>
		folderOutcome(`${mach.name}'s folder mounts after ${elapsed()}s`, at, mach, (o) => o.folder === MOUNTED);
	/** A refusal as the gateway threw it: its code and the folder's cause, with the words the contracts give it. */
	const refusalOf = (error) => {
		const folderLost = typeof error?.folderLost === "string" ? error.folderLost : null;
		return { t: elapsed(), message: String(error?.message ?? error).slice(0, 300), code: typeof error?.code === "string" ? error.code : null,
			folderLost, lost: folderLost ? (code.CLOUD_MACHINE_FOLDER_LOST[folderLost] ?? null) : null };
	};
	assert.equal(code.CLOUD_MACHINE_FOLDER_LOST.restart_view_closed, WORDS.lostViewClosed, "P4: the folder's lost words changed");

	// A machine_run as the runtime's tool makes it: its receipt begun over the exact operation the executor rebuilds,
	// the gateway's start with the run's holder, the receipt completed with what came back.
	const machineRun = async (who, key, command, input, mach = p4) => {
		const run = runs[who];
		let inputSha256 = input?.inputSha256;
		const commandId = input?.commandId ?? randomUUID();
		if (!input) {
			const described = await db.rpc("qorpera_describe_native_tool_authority", { p_binding: run.binding });
			const identity = code.parseCloudNativeToolAuthority(
				{ schema: "qorpera.native-tool-authority/v1", identity: described.identity, validForMs: 1 },
				run.binding,
			).identity;
			inputSha256 = sha256hex(
				code.cloudNativeToolOperationEnvelope(identity, {
					tool: "machine_run", toolVersion: code.CLOUD_MACHINE_TOOL_VERSION, logicalOperationKey: key,
					arguments: { operationKey: key, machine: mach.name, command, notify: false },
					target: { realm: "company_machine", machineId: mach.id }, requiresCompanyRevision: false,
				}),
			);
			await db.rpc("qorpera_begin_native_tool_operation", {
				p_binding: run.binding, p_receipt_id: commandId, p_logical_operation_key: `machine_run:${key}`,
				p_input_sha256: inputSha256, p_downstream_idempotency_sha256: "5".repeat(64), p_requires_company_revision: false,
			});
		}
		const startInput = { commandId, inputSha256, command, timeoutMs: null, notify: false };
		let receipt = null;
		let refusal = null;
		let refused = null;
		try {
			receipt = await run.gateway.start({ machineId: mach.id }, startInput, signal);
		} catch (error) {
			refusal = String(error?.message ?? error);
			refused = refusalOf(error);
		}
		if (!input)
			await db.rpc("qorpera_complete_native_tool_operation", {
				p_binding: run.binding, p_receipt_id: commandId, p_input_sha256: inputSha256,
				p_result: receipt ?? { error: refusal },
			});
		say(`${who} ${key}: ${receipt ? `start ${receipt.state}` : `refused ${refusal}`}`);
		return { commandId, input: startInput, receipt: receiptOf(receipt), refusal, refused };
	};
	const read = async (who, commandId, mach = p4) =>
		receiptOf(await runs[who].gateway.read({ machineId: mach.id }, { commandId }, signal));
	/** A read or a cancel that may be refused: the receipt, or the refusal. */
	const tryRead = async (who, commandId, mach = p4) => {
		try {
			return { receipt: await read(who, commandId, mach), at: Date.now() };
		} catch (error) {
			return { refused: refusalOf(error), at: Date.now() };
		}
	};
	const tryCancel = async (who, commandId, mach = p4) => {
		try {
			return { receipt: receiptOf(await runs[who].gateway.cancel({ machineId: mach.id }, commandId, signal)), at: Date.now() };
		} catch (error) {
			return { refused: refusalOf(error), at: Date.now() };
		}
	};
	const readDone = (who, commandId, timeoutMs = 180_000, mach = p4) =>
		until(`${who}'s command ${commandId} ends`, async () => {
			const receipt = await read(who, commandId, mach);
			return receipt.state === "running" ? null : receipt;
		}, { timeoutMs, signal });
	/** The ops' boundary reports for `path` since `at`, on one placement: which call asked, and what came of the path. */
	const reportsOf = (path, at, placement) =>
		ops
			.filter((o) => o.op === "boundary" && o.at >= at && o.machine === placement && o.answer?.views)
			.flatMap((o) =>
				o.answer.views.flatMap((view) =>
					(view.report?.paths ?? [])
						.filter((p) => p.path === path)
						.map((p) => ({ t: o.t, at: o.at, answeredAt: o.answeredAt, by: o.by, byCommand: o.byCommand, final: o.final,
							seq: view.report.seq, ...p })),
				),
			);
	/** A machine made by a run of `who`'s (628's mc_start), and when it is up with its folder settled. */
	const makeMachine = async (who, name, key) => {
		const at = Date.now();
		const answer = await db.asRun(
			runs[who].binding,
			`p4.mc_start(${literal(key)}, ${literal({ name, purpose: "Prove the test machine folder", cpus: 2, memoryGiB: 2, diskGiB: 10, lifetime: "always-on" })})`,
		);
		const id = db.query(`select id from public.qorpera_company_machines where name = ${literal(name)} and removed_at is null`);
		assert(id, `P4: ${name} was not made: ${JSON.stringify(answer)}`);
		return { mach: { name, id }, answer, at };
	};
	/** A machine deleted by a run of `who`'s, and gone: from SQL and from LXD. */
	const removeMachine = async (who, mach) => {
		const lxdNames = placements(mach.id).map((p) => code.lxdCompanyMachineName(p.id));
		const request = await db.asRun(
			runs[who].binding,
			`public.qorpera_native_machine_manage(p4.mc_binding(), ${literal({ action: "delete", machine: mach.name })})`,
		);
		await until(`${mach.name} is removed`, async () => {
			if (!machineRow(mach.name)?.removedAt) return false;
			const listed = JSON.parse((await lxc(project, ["list", "--format", "json"])).stdout || "[]").map((i) => i.name);
			return !lxdNames.some((n) => listed.includes(n));
		}, { timeoutMs: 6 * 60_000, everyMs: 3000, signal });
		return { request, removed: true, t: elapsed() };
	};

	// 1. A start boots: the host opens the boot's view, the guest's folder-mount mounts /company, and a command reads it.
	const bootAt = Date.now();
	await observeNode();
	const startAnswer = await db.asRun(
		runs.alice.binding,
		`p4.mc_start('p4-boot', ${literal({ name: MACHINE, purpose: "Prove the test machine folder", cpus: 2, memoryGiB: 2, diskGiB: 10, lifetime: "always-on" })})`,
	);
	machineId = db.query(`select id from public.qorpera_company_machines where name = ${literal(MACHINE)} and removed_at is null`);
	steps.boot = { machineId, startAnswer };
	assert(machineId, `P4: the machine was not made: ${JSON.stringify(startAnswer)}`);
	say(`machine ${machineId} started; waiting for its folder`);
	const mounted = await mountedSince(bootAt);
	const placementId = mounted.placementId;
	const lxdName = code.lxdCompanyMachineName(placementId);
	steps.boot = { ...steps.boot, placementId, lxdName, mounted: true, mountedAt: mounted.t };
	const bootView = views().find((v) => v.state === "open");
	steps.boot.view = bootView;
	steps.boot.opens = opens.filter((o) => o.viewId === bootView?.id);
	// 6e-1: the placement's binding is v2, and the machine has no repository disk.
	steps.boot.placement = placements(machineId).find((p) => p.id === placementId) ?? null;
	const listedBoot = JSON.parse((await lxc(project, ["list", lxdName, "--format", "json"])).stdout || "[]")[0];
	steps.boot.devices = Object.entries(listedBoot?.expanded_devices ?? {}).map(([name, d]) => ({ name, type: d.type ?? null,
		path: d.path ?? null }));
	const looked = await machineRun(
		"alice", "p4-boot-look",
		"ls /company; ls /company/p4; cat /company/p4/seed.md; test -e /mnt/repository && echo repository-present || echo no-repository",
	);
	steps.boot.command = looked.commandId;
	steps.boot.startReceipt = looked.receipt;
	steps.boot.receipt = await readDone("alice", looked.commandId);
	await until("the boot command's end is recorded", () => commandRow(looked.commandId)?.endedAt, { timeoutMs: 120_000, signal });
	say(`boot: view ${bootView?.id} boot ${bootView?.bootId}; read ${JSON.stringify(steps.boot.receipt.output)}`);

	// 2. A command writes and is credited; its output waits for a released boundary.
	folder.held = true;
	const heldAt = Date.now();
	const credit = await machineRun("alice", "p4-credit", "echo a > /company/p4/alice.txt; echo wrote-alice");
	steps.credit = { commandId: credit.commandId, runId: runs.alice.binding.runId, start: credit.receipt };
	await sleep(6000, undefined, { signal });
	steps.credit.heldRead = await read("alice", credit.commandId);
	await sleep(4000, undefined, { signal });
	steps.credit.heldBoundaries = ops.filter((o) => o.at >= heldAt && o.answer === "held").length;
	steps.credit.committedWhileHeld = entries("p4/alice.txt");
	folder.held = false;
	const releasedAt = Date.now();
	steps.credit.released = await readDone("alice", credit.commandId);
	const readBackAt = Date.now();
	steps.credit.releasedFirst = ops.some(
		(o) => o.at >= releasedAt && o.answeredAt <= readBackAt && o.answer?.reads === "released",
	);
	await until("alice.txt is committed", () => entries("p4/alice.txt") === 1, { timeoutMs: 120_000, signal });
	await until("the credit command's end is recorded", () => commandRow(credit.commandId)?.endedAt, { timeoutMs: 120_000, signal });
	steps.credit.commits = commits();
	say(`credit: held read ${JSON.stringify(steps.credit.heldRead)}; released ${JSON.stringify(steps.credit.released)}`);

	// 3. Reads (before any of Bob's commands): the view's reads, released to Alice's run while her command ran and taken
	// in by it at each read that let her output out (the host, 6d-3b), and taken in by Bob's run (6a-3) through SQL.
	steps.reads = { viewId: bootView.id };
	steps.reads.viewReads = readPaths("qorpera_folder_view_read_records", "view_id", bootView.id);
	steps.reads.aliceRunReads = readPaths("qorpera_folder_run_read_records", "run_id", runs.alice.binding.runId);
	steps.reads.bobBefore = readPaths("qorpera_folder_run_read_records", "run_id", runs.bob.binding.runId);
	// What 6a-3 asks of Bob's run, whose agent's view it is not: the company audience, and its agent and member reading
	// the root now.
	steps.reads.bobAuthority = db.json(`select jsonb_build_object('audience', r.audience_kind, 'staffAgentId', r.staff_agent_id,
		'requesterUserId', r.requested_by_user_id, 'readsRoot', public.qorpera_folder_reads_root(r.environment_id, f.profile_id,
			r.staff_agent_id, r.requested_by_user_id))
		from public.qorpera_execution_runs r join public.qorpera_company_files f on f.environment_id = r.environment_id
		where r.id = ${literal(runs.bob.binding.runId)}`);
	// The take-in as the run that reads a command's output would make it: Alice's run (her machine's view), and Bob's
	// (6a-3 lets a company-audience run take it in, and refuses any other).
	const takeIn = async (who) => {
		const b = runs[who].binding;
		try {
			const inherited = await db.rpc("qorpera_folder_run_inherit_view_reads", {
				p_environment_id: ENV,
				p_run_actor: { kind: "run", runId: b.runId, jobId: b.jobId, runnerId: b.runnerId, assignmentId: b.assignmentId },
				p_view_id: bootView.id, p_inherit_id: randomUUID(),
			});
			// `reads` is how many reads the take-in carried.
			return { schema: inherited?.schema, viewId: inherited?.viewId, reads: inherited?.reads, replay: inherited?.replay };
		} catch (error) {
			return { error: String(error?.message ?? error).slice(0, 600) };
		}
	};
	steps.reads.bob = await takeIn("bob");
	steps.reads.bobAfter = readPaths("qorpera_folder_run_read_records", "run_id", runs.bob.binding.runId);
	steps.reads.alice = await takeIn("alice");
	say(
		`reads: view ${JSON.stringify(steps.reads.viewReads)}; alice ${JSON.stringify(steps.reads.alice)}; bob ` +
			`${JSON.stringify(steps.reads.bobBefore)} -> ${JSON.stringify(steps.reads.bobAfter)} ${JSON.stringify(steps.reads.bob)}`,
	);

	// 4. Overlap: two runs' commands at once, each change credited to the windows open as it was made.
	const overB = await machineRun(
		"bob", "p4-overlap-b",
		"echo b > /company/p4/bob-only.txt; sleep 6; echo b >> /company/p4/shared.txt; sleep 2; echo bob-done",
	);
	await sleep(3000, undefined, { signal });
	const overC = await machineRun(
		"carol", "p4-overlap-c",
		"sleep 1; echo c >> /company/p4/shared.txt; sleep 24; echo carol > /company/p4/carol-after.txt; echo carol-done",
	);
	const [receiptB, receiptC] = await Promise.all([readDone("bob", overB.commandId), readDone("carol", overC.commandId)]);
	await until("carol-after.txt is committed", () => entries("p4/carol-after.txt") === 1, { timeoutMs: 120_000, signal });
	// A window stays open until the host's pass records its command's end, and a change made while it is open is credited
	// to it too. M (below) starts only after B's and C's ends are recorded, so its write is credited to M alone.
	await until(
		"B's and C's ends are recorded",
		() => commandRow(overB.commandId)?.endedAt && commandRow(overC.commandId)?.endedAt,
		{ timeoutMs: 120_000, signal },
	);
	steps.overlap = { b: overB.commandId, c: overC.commandId, receipts: { b: receiptB, c: receiptC }, commits: commits() };
	say(`overlap: B ${receiptB.state} C ${receiptC.state}`);

	/** The answered close of a command's window, as the host's pass sends it once it records the command's end. */
	const closedOn = (id, placement = placementId) =>
		ops.find((o) => o.op === "closeWindow" && o.machine === placement && o.commandId === id && o.answeredAt) ?? null;
	const soft = (p) => p.catch((error) => ({ error: String(error?.message ?? error).slice(0, 300) }));

	// 5. vsock: from inside the guest, every port of the host (CID 2). Each port that answers needs an allowed owner, read
	// (read-only) from this test machine's `ss -l -p --vsock` while the probe runs.
	const probe = await machineRun("alice", "p4-vsock", VSOCK_PROBE);
	const ownersAtProbe = vsockOwners();
	const probed = await soft(readDone("alice", probe.commandId, 600_000));
	if (probed.error) await tryCancel("alice", probe.commandId);
	const probeLine = String(probed.output ?? "").trim().split("\n").at(-1) ?? "";
	let probeAnswer;
	try {
		probeAnswer = JSON.parse(probeLine);
	} catch {
		probeAnswer = { unparsed: probeLine.slice(0, 300), error: probed.error ?? null };
	}
	const owners = await ownersAtProbe;
	const ports = (Array.isArray(probeAnswer.answered) ? probeAnswer.answered : []).map((port) => {
		const on = owners.listeners.filter((l) => l.port === port && (l.cid === "*" || l.cid === "2"));
		return { port, cid: on.map((l) => l.cid), owners: on.map((l) => ({ processes: l.processes, unit: l.unit })) };
	});
	steps.vsockPorts = { commandId: probe.commandId, receipt: { state: probed.state ?? null, exitCode: probed.exitCode ?? null,
		companyFolder: probed.companyFolder ?? null }, probe: probeAnswer, bridgePid: bridge.pid ?? null, virt: owners.virt,
		virtExit: owners.virtExit, ports, listeners: owners.listeners, ssLines: owners.lines, ssError: owners.ssError };
	await soft(until("the probe's window closes", () => closedOn(probe.commandId), { timeoutMs: 120_000, signal }));
	say(`vsock: ${JSON.stringify(probeAnswer)}; virt ${owners.virt}; answering ${JSON.stringify(ports)}`);

	// 6. Detached: a command starts a writer outside its own unit and ends; once the host has recorded its end (its window
	// closed), the writer writes. No window is open: the change is the starter's, with no command credit.
	const detachedUnit = `p4-detached-${randomBytes(4).toString("hex")}`;
	const detachedRun = await machineRun("alice", "p4-detached",
		`systemd-run --no-block --quiet --unit=${detachedUnit} /bin/sh -c 'while [ ! -e /run/p4-go ]; do sleep 1; done; echo detached > /company/p4/detached.txt'; echo started`);
	const detachedReceipt = await readDone("alice", detachedRun.commandId);
	const detachedEnd = await soft(until("the detached starter's end is recorded and its window closed", () => {
		const row = commandRow(detachedRun.commandId);
		const closed = closedOn(detachedRun.commandId);
		return row?.endedAtMs && closed ? { endedAtMs: Number(row.endedAtMs), closedAt: closed.answeredAt } : null;
	}, { timeoutMs: 180_000, signal }));
	const detached = { commandId: detachedRun.commandId, unit: detachedUnit, start: detachedRun.receipt, receipt: detachedReceipt,
		...detachedEnd };
	steps.detached = detached;
	detached.running = commandRows().filter((r) => r.placementId === placementId && !r.endedAt).map((r) => r.id);
	detached.unclosed = commandRows()
		.filter((r) => r.placementId === placementId && r.id !== detachedRun.commandId && !closedOn(r.id))
		.map((r) => r.id);
	detached.goAt = Date.now();
	detached.go = (await lxc(project, ["exec", lxdName, "--", "touch", "/run/p4-go"])).status;
	detached.committed = await soft(until("detached.txt is committed", () => entries("p4/detached.txt") === 1, { timeoutMs: 120_000, signal }));
	detached.commits = commits().filter((c) => c.units.some((u) => u.path === "p4/detached.txt"));
	say(`detached: ${JSON.stringify(detached.commits.map((c) => ({ actor: c.actorId, credits: c.credits })))}`);

	// 7. Loop: L writes /company/p4/loop.txt at every 10 s of the guest's clock. With the passes paused (no pass asks for a
	// boundary), each change is committed by the service's quiet publish, about 2 s after it is made; then a read of L
	// right after a write publishes it at the read's boundary; then a cancel publishes L's last change.
	const loop = {};
	steps.loop = loop;
	await pausePasses("loop");
	let loopRun;
	try {
		loop.clock = await guestClock(project, lxdName);
		const off = loop.clock.offsetMs;
		const tickAfter = (h) => Math.floor((h + off) / 10000 + 1) * 10000 - off;
		loopRun = await machineRun("alice", "p4-loop", LOOP_COMMAND);
		loop.commandId = loopRun.commandId;
		loop.start = loopRun.receipt;
		const fromAt = Date.now();
		const toAt = tickAfter(tickAfter(tickAfter(fromAt))) + 6000;
		await sleep(Math.max(0, toAt - Date.now()), undefined, { signal });
		loop.quiet = {
			fromAt, toAt,
			boundaries: ops.filter((o) => (o.op === "boundary" || o.op === "closeWindow") && o.machine === placementId && o.at >= fromAt && o.at <= toAt).length,
		};
		loop.reads = [];
		let lag = 1000;
		for (let attempt = 0; attempt < 4; attempt++) {
			const tick = tickAfter(Date.now() + lag);
			await sleep(Math.max(0, tick + 600 - lag - Date.now()), undefined, { signal });
			const calledAt = Date.now();
			const tried = await tryRead("alice", loopRun.commandId);
			const boundary = ops.find((o) => o.op === "boundary" && o.machine === placementId && o.by === "read" &&
				o.byCommand === loopRun.commandId && o.at >= calledAt);
			const hit = reportsOf("p4/loop.txt", calledAt, placementId)
				.find((r) => r.by === "read" && r.byCommand === loopRun.commandId && r.outcome === "saved") ?? null;
			loop.reads.push({ tick, calledAt, lag, boundaryAt: boundary?.at ?? null, receipt: tried.receipt ? { state: tried.receipt.state,
				companyFolder: tried.receipt.companyFolder } : null, refused: tried.refused ?? null, hit });
			if (boundary) lag = Math.max(0, boundary.at - calledAt);
			if (hit) break;
		}
		const cancelAt = tickAfter(Date.now()) + 5000;
		await sleep(Math.max(0, cancelAt - Date.now()), undefined, { signal });
		const cancelled = await tryCancel("alice", loopRun.commandId);
		loop.cancel = { at: cancelAt, receipt: cancelled.receipt ?? null, refused: cancelled.refused ?? null,
			report: reportsOf("p4/loop.txt", cancelAt, placementId).find((r) => r.by === "cancel" && r.byCommand === loopRun.commandId) ?? null };
	} finally {
		resumePasses();
	}
	loop.final = await soft(readDone("alice", loopRun.commandId));
	const offset = loop.clock.offsetMs;
	loop.ticks = [...String(loop.final.output ?? "").matchAll(/^tick (\d+) (\d+)$/gm)].map((m) => ({ n: Number(m[1]), t: Number(m[2]),
		at: Number(m[2]) - offset }));
	const loopLook = await machineRun("alice", "p4-loop-look", "cat /company/p4/loop.txt");
	const loopLooked = await readDone("alice", loopLook.commandId);
	const lastLine = String(loopLooked.output ?? "").trim().split("\n").at(-1) ?? "";
	const lastMatch = /^(\d+) last (\d+)$/.exec(lastLine);
	loop.last = lastMatch ? { n: Number(lastMatch[1]), t: Number(lastMatch[2]), last: true } : { line: lastLine.slice(0, 200), last: false };
	await soft(until("L's and the look's windows close", () => closedOn(loopRun.commandId) && closedOn(loopLook.commandId), {
		timeoutMs: 120_000, signal,
	}));
	loop.commits = commits().flatMap((c) =>
		c.units.filter((u) => u.path === "p4/loop.txt").map((u) => ({ seq: c.seq, createdAtMs: Number(c.createdAtMs),
			credits: Array.isArray(u.credits) ? u.credits : c.credits, actorId: c.actorId })),
	);
	say(`loop: ${loop.ticks.length} ticks, ${loop.commits.length} commits; reads ${JSON.stringify(loop.reads.map((r) => r.hit?.outcome ?? null))}; cancel ${loop.cancel?.report?.outcome}`);

	// 8. Stop: the final boundary, the view closed in SQL, the VM powered off, `restarted`; then a second boot. S writes
	// every half second while the machine stops: its last change, made right before the boot's folder ends, is published
	// by the stop's boundaries before the power-off.
	const stopClock = await guestClock(project, lxdName);
	const stopLoop = await machineRun("alice", "p4-stop-loop", STOP_LOOP_COMMAND);
	await sleep(4000, undefined, { signal });
	const stopAt = Date.now();
	steps.stop = { viewId: bootView.id, bootId: bootView.bootId };
	steps.stop.request = await db.asRun(
		runs.alice.binding,
		`public.qorpera_native_machine_manage(p4.mc_binding(), ${literal({ action: "stop", machine: MACHINE })})`,
	);
	steps.stop.outcome = await until(
		"the machine stops",
		() => outcomes.find((o) => o.at >= stopAt && o.placementId === placementId && o.step === "stop" && o.state === "done"),
		{ timeoutMs: 6 * 60_000, signal },
	);
	steps.stop.finalBoundary = ops.find((o) => o.at >= stopAt && o.op === "boundary" && o.final.length > 0) ?? null;
	steps.stop.restarted = ops.some((o) => o.at >= stopAt && o.op === "restarted" && o.answer === "ok");
	steps.stop.view = views().find((v) => v.id === bootView.id);
	steps.stop.instanceStatus = JSON.parse((await lxc(project, ["list", lxdName, "--format", "json"])).stdout || "[]")[0]?.status ?? null;
	steps.stop.loop = {
		commandId: stopLoop.commandId, start: stopLoop.receipt, clock: stopClock,
		reports: reportsOf("p4/stop-loop.txt", stopAt, placementId),
		powerOffAt: lxdOps.find((o) => o.at >= stopAt && o.action === "stop" && o.name === lxdName)?.at ?? null,
		row: commandRow(stopLoop.commandId),
	};
	say(`stop: view ${steps.stop.view?.state} (${steps.stop.view?.closeReason}); VM ${steps.stop.instanceStatus}`);
	const wakeAt = Date.now();
	steps.stop.wake = { request: await db.asRun(runs.alice.binding, `p4.mc_start('p4-again', ${literal({ machine: MACHINE })})`) };
	await mountedSince(wakeAt);
	steps.stop.wake.mounted = true;
	const wakeView = views().find((v) => v.state === "open");
	steps.stop.wake.view = wakeView;
	steps.stop.wake.bootId = wakeView?.bootId ?? null;
	const again = await machineRun("alice", "p4-again-look", "cat /company/p4/alice.txt /company/p4/carol-after.txt /company/p4/stop-loop.txt");
	steps.stop.wake.receipt = await readDone("alice", again.commandId);
	const stopLast = /^(\d+) last (\d+)$/m.exec(String(steps.stop.wake.receipt.output ?? ""));
	steps.stop.loop.last = stopLast ? { n: Number(stopLast[1]), t: Number(stopLast[2]), last: true } : { last: false };
	await soft(until("the wake look's window closes", () => closedOn(again.commandId), { timeoutMs: 120_000, signal }));
	say(`wake: view ${wakeView?.id} boot ${wakeView?.bootId}; read ${JSON.stringify(steps.stop.wake.receipt.output)}`);

	// 9a. Refusals: a command ended in SQL is refused (the gateway's start again, and its write at the boundary).
	const m = await machineRun("carol", "p4-m", "echo m > /company/p4/m.txt; echo wrote-m");
	const mReceipt = await readDone("carol", m.commandId);
	await until("m.txt is committed and M's end recorded", () => entries("p4/m.txt") === 1 && commandRow(m.commandId)?.endedAt, {
		timeoutMs: 120_000, signal,
	});
	// K writes only after SQL ended it: its window stays open in the service until the guest says K ended, so the write
	// is credited to K, and the service's publish after its quiet period (or the next boundary) sends it. The host's look
	// lists only the commands SQL has not ended, so K's window is never closed and stays open for the rest of the boot
	// (every later change on it would be K's, and refused): this runs last on p4.
	const k = await machineRun("bob", "p4-k", "sleep 5; echo k > /company/p4/k.txt; sleep 15; echo k-done");
	const endedAt = Date.now();
	db.query(`do $$ declare m public.qorpera_company_machines;
		begin
			select * into m from public.qorpera_company_machines where id = ${literal(machineId)} for update;
			perform public.qorpera_end_company_machine_commands(m, 'stopped', ${literal([k.commandId])});
		end $$;`);
	const kRow = commandRow(k.commandId);
	const resend = await machineRun("bob", "p4-k", k.input.command, k.input);
	// A read of K once SQL ended it: what its receipt says of the folder (SQL ended it, not the folder: no `lost`).
	const kRead = await tryRead("bob", k.commandId);
	await sleep(8000, undefined, { signal });
	// A boundary after K's write: a read of M, which ended before K started.
	const mAgain = await read("carol", m.commandId);
	// K's unit is answered by a boundary (in its report) or by the quiet period's publish (in the service's log); a
	// boundary while K's bytes were still on their way says waiting, which is no answer (run 3).
	const kReport = await until("k.txt's unit is answered",
		() => answeredUnit(ops, serviceLog, "p4/k.txt", endedAt, (endedAt - started) / 1000),
		{ timeoutMs: 90_000, signal }).catch((error) => ({ error: error.message }));
	steps.refusals = {
		m: { commandId: m.commandId, receipt: mReceipt, readAgain: mAgain, entries: entries("p4/m.txt") },
		k: { commandId: k.commandId, start: k.receipt, row: kRow, resend: resend.refusal, resent: resend.refused, read: kRead,
			report: kReport, entries: entries("p4/k.txt") },
		commits: commits(),
	};
	say(`ended: K ${kRow?.state}; resend ${resend.refusal}; k.txt ${JSON.stringify(kReport)}`);

	// 9b. Another machine in the project, given this view's hand-over, cannot mount it.
	const handover = handovers.at(-1);
	assert(handover?.name === lxdName, "P4: no hand-over of the machine's view was seen");
	const intruder = `qorpera-machine-${randomBytes(16).toString("hex")}`;
	steps.refusals.intruder = { name: intruder, viewId: handover.viewId };
	const made = await lxc(project, ["init", image, intruder, "--vm", "--no-profiles", "--storage", pool, "-d", "root,size=10GiB",
		"-c", "limits.cpu=1", "-c", "limits.memory=1GiB", "-c", "boot.mode=uefi-secureboot", "-c", "boot.autostart=false"]);
	const ran = made.status === 0 ? await lxc(project, ["start", intruder]) : made;
	steps.refusals.intruder.made = { status: ran.status, stderr: ran.stderr };
	if (ran.status === 0) {
		await until(
			"the second machine's agent answers",
			async () => (await lxc(project, ["exec", intruder, "--", "true"], { timeoutMs: 30_000 })).status === 0,
			{ timeoutMs: 300_000, everyMs: 3000, signal },
		);
		const guest = async (args, stdin) => {
			const nonce = randomUUID();
			try {
				if (stdin)
					await lxd.execInstanceStream(project, intruder, {
						command: ["/usr/bin/node", HELPER, nonce, ...args], stdin, maxStdoutBytes: 65536, maxStderrBytes: 65536,
						timeoutMs: 100_000,
					}, signal);
				else await lxd.execInstance(project, intruder, ["/usr/bin/node", HELPER, nonce, ...args], signal);
			} catch (error) {
				return { exec: String(error?.message ?? error).slice(0, 300) };
			}
			try {
				const file = await lxd.readInstanceFile(project, intruder, `/run/qorpera-machine/replies/${nonce}.json`, 65536, signal);
				return JSON.parse(new TextDecoder().decode(file.content));
			} catch (error) {
				return { reply: String(error?.message ?? error).slice(0, 300) };
			}
		};
		const triedAt = elapsed();
		steps.refusals.intruder.prepare = await guest(["prepare", machineId, "1"]);
		const answer = await guest(["folder-mount"], handover.stdin);
		steps.refusals.intruder.answer = answer;
		steps.refusals.intruder.mount = answer?.mount ?? null;
		steps.refusals.intruder.opens = opens.filter((o) => o.t >= triedAt && o.machine === intruder);
		steps.refusals.intruder.removed = (await lxc(project, ["delete", "--force", intruder])).status;
	}
	const still = await machineRun("alice", "p4-still", "cat /company/p4/alice.txt");
	steps.refusals.stillReads = await readDone("alice", still.commandId);
	say(`other machine: ${JSON.stringify(steps.refusals.intruder.mount)}; opens ${JSON.stringify(steps.refusals.intruder.opens)}`);
	evidence.sql = { views: views(), commands: commandRows(), commits: commits() };
	steps.p4Removed = await removeMachine("alice", p4);
	say("p4 removed");

	// The machine's look at its folder, and at what a boot-time service would have left on its disk.
	const LOOK = [
		"if findmnt /company >/dev/null; then echo company-mounted; else echo no-company; fi",
		"echo \"entries $(ls -A /company | wc -l)\"",
		"test -e /etc/systemd/system/p4-marker.service && echo unit-present || echo no-unit",
		"test -e /var/lib/p4-marker && echo marker-present || echo no-marker",
		"cat /company/p4/seed.md 2>/dev/null || true",
	].join("\n");
	const looked2 = async (who, key, mach) => {
		const ran = await machineRun(who, key, LOOK, undefined, mach);
		return { commandId: ran.commandId, start: ran.receipt, refused: ran.refused,
			receipt: ran.receipt ? await readDone(who, ran.commandId, 180_000, mach) : null };
	};

	// 10. No root read: Bob's agent no longer reads the root when his run starts a machine. The open is refused, so the
	// boot has no /company, and every receipt says so (company "none", with the core's why).
	const bare = {};
	steps.noRootRead = bare;
	bare.revoked = revokeRoot(STAFF.bob);
	bare.readsRoot = readsRoot(STAFF.bob);
	const bareFrom = db.failures.length;
	const madeBare = await makeMachine("bob", "p4-bare", "p4-bare-start");
	const bareMach = madeBare.mach;
	bare.machineId = bareMach.id;
	bare.outcome = await folderOutcome("p4-bare's boot settles", madeBare.at, bareMach, (o) =>
		/^FOLDER_(NONE|FENCED|MOUNTED|HELD)/.test(o.folder ?? ""),
	);
	const bareOld = bare.outcome.placementId;
	bare.look = await looked2("bob", "p4-bare-look", bareMach);
	bare.placement = placements(bareMach.id).find((p) => p.id === bareOld) ?? null;
	bare.views = views(bareMach.id);
	bare.openFailures = openFailures(bareFrom);
	say(`no root read: ${bare.outcome.folder}; ${JSON.stringify(bare.look.receipt?.output)} ${JSON.stringify(bare.look.receipt?.companyFolder)}`);

	// 11. Reverse: Bob's agent, still without the root read, installs a service that writes a marker at every boot. Then
	// it reads the root again: the next boot's open is refused (the disk was used without the root-read check), the
	// placement is retired, and the machine starts on a new disk, with /company and without the service.
	const reverse = {};
	steps.reverse = reverse;
	const install = await machineRun("bob", "p4-bare-install", [
		"cat > /etc/systemd/system/p4-marker.service <<'UNIT'",
		"[Unit]",
		"Description=P4 marker written at boot",
		"[Service]",
		"Type=oneshot",
		"ExecStart=/bin/sh -c 'echo marker > /var/lib/p4-marker'",
		"[Install]",
		"WantedBy=multi-user.target",
		"UNIT",
		"systemctl daemon-reload && systemctl enable --quiet p4-marker.service && systemctl start p4-marker.service",
		"cat /var/lib/p4-marker && echo installed",
	].join("\n"), undefined, bareMach);
	reverse.install = install.receipt ? await readDone("bob", install.commandId, 180_000, bareMach) : { refused: install.refused };
	reverse.restored = restoreRoot(STAFF.bob, bare.revoked?.since);
	reverse.readsRoot = readsRoot(STAFF.bob);
	const bareStopAt = Date.now();
	reverse.stop = await db.asRun(
		runs.bob.binding,
		`public.qorpera_native_machine_manage(p4.mc_binding(), ${literal({ action: "stop", machine: "p4-bare" })})`,
	);
	reverse.stopped = await until(
		"p4-bare stops",
		() => outcomes.find((o) => o.at >= bareStopAt && o.placementId === bareOld && o.step === "stop" && o.state === "done"),
		{ timeoutMs: 6 * 60_000, signal },
	);
	const reverseFrom = db.failures.length;
	const bareAgainAt = Date.now();
	reverse.start = await db.asRun(runs.bob.binding, `p4.mc_start('p4-bare-again', ${literal({ machine: "p4-bare" })})`);
	reverse.retired = await folderOutcome("p4-bare's disk is retired", bareAgainAt, bareMach, (o) =>
		o.placementId === bareOld && /^FOLDER_RETIRED/.test(o.folder ?? ""),
	);
	reverse.mounted = await folderOutcome("p4-bare mounts on a new disk", bareAgainAt, bareMach, (o) =>
		o.placementId !== bareOld && o.folder === MOUNTED,
	);
	reverse.old = placements(bareMach.id).find((p) => p.id === bareOld) ?? null;
	reverse.placement = placements(bareMach.id).find((p) => p.id === reverse.mounted.placementId) ?? null;
	reverse.openFailures = openFailures(reverseFrom);
	reverse.look = await looked2("bob", "p4-bare-new-look", bareMach);
	reverse.commands = commandRows(bareMach.id);
	reverse.removed = await removeMachine("bob", bareMach);
	say(`reverse: ${reverse.retired.folder} -> ${reverse.mounted.folder}; ${JSON.stringify(reverse.look.receipt?.output)}`);

	// 12. Narrowed: the starter of a machine with /company loses the root read. Until the machine restarts, Carol's run is
	// refused every command on it (Alice's, whose agent still reads the root, is not); the core closes the boot's view,
	// the host restarts the guest, the next boot's open is refused, the placement is retired, and the machine starts on
	// a new disk once Carol reads the root again.
	const narrow = {};
	steps.narrowed = narrow;
	const madeNarrow = await makeMachine("carol", "p4-narrow", "p4-narrow-start");
	const narrowMach = madeNarrow.mach;
	narrow.machineId = narrowMach.id;
	narrow.mounted = await mountedSince(madeNarrow.at, narrowMach);
	const narrowOld = narrow.mounted.placementId;
	const aLong = await machineRun("alice", "p4-narrow-a", "echo a-long; sleep 600", undefined, narrowMach);
	const c0 = await machineRun("carol", "p4-narrow-c0", "echo c0; sleep 600", undefined, narrowMach);
	Object.assign(narrow, { aLong: aLong.commandId, c0: c0.commandId, aLongStart: aLong.receipt, c0Start: c0.receipt });
	await sleep(3000, undefined, { signal });
	narrow.aliceBefore = await tryRead("alice", aLong.commandId, narrowMach);
	// Both are asked before the revoke, so the passes pause at the restart and again at the retirement whenever they
	// come: Carol reads the root again before the new disk's open. The restart is heard whatever its reason (the judge
	// says which one counts), so a later one does not let the retirement pass unheard.
	const viewClosed = hearOutcome(
		"p4-narrow's view is closed and its guest restarted",
		(o) => o.placementId === narrowOld && /^FOLDER_RESTART:/.test(o.folder ?? ""),
		{ pause: true, timeoutMs: 5 * 60_000 },
	).catch((error) => ({ error: String(error?.message ?? error) }));
	const retired = hearOutcome(
		"p4-narrow's disk is retired",
		(o) => o.placementId === narrowOld && /^FOLDER_RETIRED/.test(o.folder ?? ""),
		{ pause: true, timeoutMs: 20 * 60_000 },
	).catch((error) => ({ error: String(error?.message ?? error) }));
	narrow.revoked = revokeRoot(STAFF.carol);
	narrow.readsRoot = readsRoot(STAFF.carol);
	const carolFrom = db.failures.length;
	const carolRun = await machineRun("carol", "p4-narrow-c1", "echo c1", undefined, narrowMach);
	narrow.carol = {
		run: { receipt: carolRun.receipt, refused: carolRun.refused },
		read: await tryRead("carol", c0.commandId, narrowMach),
		cancel: await tryCancel("carol", c0.commandId, narrowMach),
	};
	narrow.carolFailures = db.failures.slice(carolFrom).filter((f) => f.method === "qorpera_authorize_machine_command");
	narrow.aliceDuring = await tryRead("alice", aLong.commandId, narrowMach);
	narrow.viewClosed = await viewClosed;
	// The ended boot, as Alice's read of her command on it says (the passes paused: no next boot yet).
	narrow.endedTries = [];
	narrow.ended = await until("Alice's read says the boot ended", async () => {
		const tried = await tryRead("alice", aLong.commandId, narrowMach);
		if (narrow.endedTries.length < 20) narrow.endedTries.push(tried);
		const f = tried.receipt?.companyFolder;
		return f?.company === "none" && f.heldBack === WORDS.heldEnded ? tried : null;
	}, { timeoutMs: 120_000, everyMs: 3000, signal }).catch((error) => ({ error: String(error?.message ?? error) }));
	const narrowFrom = db.failures.length;
	resumePasses();
	narrow.retired = await retired;
	// Carol reads the root again before the new disk's open (the passes paused right after the retirement).
	narrow.restored = restoreRoot(STAFF.carol, narrow.revoked?.since);
	narrow.readsRootAgain = readsRoot(STAFF.carol);
	const restoredAt = Date.now();
	resumePasses();
	narrow.old = placements(narrowMach.id).find((p) => p.id === narrowOld) ?? null;
	narrow.openFailures = openFailures(narrowFrom);
	narrow.oldViews = views(narrowMach.id).filter((v) => v.placementId === narrowOld);
	narrow.newMounted = await folderOutcome("p4-narrow mounts on a new disk", restoredAt, narrowMach, (o) =>
		o.placementId !== narrowOld && o.folder === MOUNTED,
	);
	narrow.aLongRow = commandRow(aLong.commandId, narrowMach);
	narrow.c0Row = commandRow(c0.commandId, narrowMach);
	narrow.aliceAfter = await tryRead("alice", aLong.commandId, narrowMach);
	narrow.look = await looked2("carol", "p4-narrow-look", narrowMach);
	narrow.removed = await removeMachine("carol", narrowMach);
	say(`narrowed: ${narrow.viewClosed?.folder} ${narrow.retired?.folder} -> ${narrow.newMounted.folder}; after ${JSON.stringify(narrow.aliceAfter)}`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!options.execute) {
		process.stderr.write(`${USAGE}\n`);
		process.exit(2);
	}
	const evidence = {
		schema: "qorpera.p4-test-machine-folder/v1",
		startedAt: new Date(started).toISOString(),
		project: options.project,
		image: options.image,
		helperSha256: options.helperSha256,
		steps: {},
		cleanupErrors: [],
	};
	const cleanups = [];
	const secrets = {};
	try {
		await prove(options, evidence, cleanups, secrets);
	} catch (error) {
		evidence.error = String(error?.stack ?? error).slice(0, 4000);
		say(`FAILED: ${String(error?.message ?? error).slice(0, 500)}`);
	} finally {
		for (const cleanup of cleanups.reverse())
			await cleanup().catch((error) => evidence.cleanupErrors.push(String(error?.message ?? error).slice(0, 300)));
	}
	evidence.finishedAt = new Date().toISOString();
	evidence.deadlocks = deadlocksIn(evidence);
	let text = JSON.stringify(evidence, null, "\t");
	const leaks = findSecrets(text, secrets);
	for (const name of leaks) text = text.replaceAll(secrets[name], `[${name} redacted]`);
	const recorded = JSON.parse(text);
	recorded.leaks = leaks;
	recorded.checks = judge(recorded, leaks);
	recorded.result = Object.values(recorded.checks).every((c) => c.ok) ? "passed" : "failed";
	writeFileSync(options.record, JSON.stringify(recorded, null, "\t"), { mode: 0o600 });
	for (const [name, c] of Object.entries(recorded.checks)) process.stdout.write(`${c.ok ? "PASS" : "FAIL"} ${name}: ${c.why}\n`);
	process.stdout.write(`P4 result: ${recorded.result}\n`);
	process.exitCode = recorded.result === "passed" ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
