import assert from "node:assert/strict";
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
 * hand-over (folder-mount's stdin) is kept in memory for the second machine's attempt. */
export function nicStandIn(client, nics = new Map(), handovers = []) {
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
						handovers.push({ project, name, stdin: Buffer.from(request.stdin) });
					return target.execInstanceStream(project, name, request, signal);
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
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
	const credit = s.credit ?? {};
	check(
		"heldUntilReleased",
		credit.heldRead?.state === "running" && credit.heldRead?.output === "" && credit.heldRead?.exitCode === null &&
			credit.heldBoundaries > 0 && credit.released?.state === "succeeded" && credit.released?.exitCode === 0 &&
			credit.released?.output?.includes("wrote-alice") && credit.releasedFirst === true,
		"while no boundary answered, a read of the finished command got running/''/null; output came after a released boundary",
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
	const took = (t) => t?.schema === "qorpera.folder-inherit/v1" && t.viewId === reads.viewId && typeof t.reads === "number";
	check(
		"readsTakenIn",
		reads.viewReads?.includes("p4/seed.md") && reads.aliceRunReads?.includes("p4/seed.md") && took(reads.alice) &&
			reads.bobBefore?.includes("p4/seed.md") === false &&
			(took(reads.bob)
				? reads.bobAfter?.includes("p4/seed.md")
				: /only with the company-wide view/.test(reads.bob?.error ?? "") && reads.bobAfter?.includes("p4/seed.md") === false),
		"the view's reads reached Alice's run and her run took them in (6a-3, through SQL); Bob's run took them in, or was " +
			"refused as a run without the company-wide view",
	);
	const refusals = s.refusals ?? {};
	const k = refusals.k ?? {};
	check(
		"endedRefused",
		k.row?.state === "lost" && k.row?.endedAt && /MACHINE_COMMAND_ENDED/.test(k.resend ?? "") &&
			/command_ended/.test(JSON.stringify(k.report ?? null)) && k.entries === 0 && refusals.m?.entries === 1 &&
			same(unitOf(refusals.commits, "p4/m.txt")?.credits, [refusals.m?.commandId]),
		"a command ended in SQL is refused again at the gateway and its write is refused command_ended at the boundary",
	);
	const intruder = refusals.intruder ?? {};
	check(
		"otherMachineRefused",
		intruder.mount && intruder.mount !== "mounted" && intruder.opens?.length > 0 && intruder.opens.every((o) => !o.ok) &&
			refusals.stillReads?.exitCode === 0 && refusals.stillReads?.output?.includes("a"),
		"a second machine in the project, with this view's hand-over, was refused by the service; the machine still reads",
	);
	const stop = s.stop ?? {};
	check(
		"stopClosed",
		stop.outcome?.state === "done" && stop.finalBoundary?.final?.includes(stop.viewId) && stop.restarted === true &&
			stop.view?.state === "closed" && stop.view?.closedAt && /stopped/i.test(stop.instanceStatus ?? ""),
		"the stop ran the final boundary, closed the view in SQL, powered the VM off and said restarted",
	);
	const wake = stop.wake ?? {};
	check(
		"secondBoot",
		wake.mounted === true && wake.bootId && wake.bootId !== stop.bootId && wake.view?.id && wake.view.id !== stop.viewId &&
			wake.view.state === "open" && wake.receipt?.exitCode === 0 && wake.receipt?.output?.includes("a"),
		"a second start booted anew with a new view, and the folder still reads",
	);
	check(
		"serviceClean",
		!evidence.error && !(evidence.cleanupErrors?.length > 0) && evidence.service?.bridgeExit === null &&
			!(evidence.service?.passErrors?.length > 0) && !evidence.service?.outcomes?.some((o) => o.state === "failed"),
		"no step failed, no host pass failed or threw, the folder bridge ran to the end, and everything this run made " +
			"in-process closed",
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
		const out = await this.session(`begin;
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
			if (db.failures.length < 400)
				db.failures.push({ t: elapsed(), method: rpc?.[1] ?? url.pathname, code: failed.value.code, details: failed.value.details,
					message: failed.value.message.slice(0, 300) });
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

const receiptOf = (r) => (r ? { state: r.state, exitCode: r.exitCode, output: r.output, totalBytes: r.log?.totalBytes } : null);

async function prove(options, evidence, cleanups, secrets) {
	const signal = AbortSignal.timeout(100 * 60_000);
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

	// The runs stay live: their jobs' and native leases' renewals, the runners' session rotation, the node's observation.
	const keeper = { renewals: 0, errors: [], stop: false };
	for (const run of Object.values(runs)) run.session = "2".repeat(64);
	let rotated = Date.now();
	const keep = async () => {
		const rotate = Date.now() - rotated > 5 * 60_000;
		if (rotate) rotated = Date.now();
		for (const run of Object.values(runs)) {
			const b = run.binding;
			const lease = sha256hex(run.token);
			try {
				if (rotate) {
					const next = randomBytes(32).toString("hex");
					await db.rpc("qorpera_heartbeat_runner", {
						p_runner_id: b.runnerId, p_current_token_sha256: run.session, p_next_token_sha256: next, p_renewal_id: randomUUID(),
					});
					run.session = next;
				}
				await db.rpc("qorpera_renew_runner_job", {
					p_runner_id: b.runnerId, p_session_token_sha256: run.session, p_job_id: b.jobId, p_lease_token_sha256: lease,
				});
				await db.rpc("qorpera_renew_native_provider_connection_lease", {
					p_lease_id: b.leaseId, p_runner_id: b.runnerId, p_session_token_sha256: run.session, p_job_id: b.jobId,
					p_lease_token_sha256: lease, p_lease_seconds: 120,
				});
				keeper.renewals++;
			} catch (error) {
				if (keeper.errors.length < 50) keeper.errors.push({ t: elapsed(), error: String(error.message).slice(0, 400) });
			}
		}
		try {
			await db.asRun(runs.alice.binding, `p4.mc_observe(${literal(NODE_ID)}, ${literal(nodeSha)}, 16000, 68719476736)`);
		} catch (error) {
			if (keeper.errors.length < 50) keeper.errors.push({ t: elapsed(), error: String(error.message).slice(0, 400) });
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
	// a window's close gets no answer, as when the service does not answer: the output must wait.
	const ops = [];
	const inner = new code.UnixFolderControl(controlPath);
	const folder = {
		held: false,
		async op(op, machine, detail, call) {
			const entry = { t: elapsed(), at: Date.now(), op, machine, ...detail };
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
	const handovers = [];
	const control = new code.CodingExecutorHttpControl({ supabaseUrl: `${ORIGIN}/`, serviceRoleKey: STAND_IN, fetch: stand.fetch });
	const host = new code.LxdCompanyMachineHost({
		control, owner: EXECUTOR, machineIdSha256: nodeSha, policy,
		client: nicStandIn(lxd, new Map(), handovers), journalRoot,
		storagePolicy: {
			schema: "qorpera.coding-nas-policy/v1", mountPoint: join(work, "nas"), source: "192.0.2.1:/p4", serverAddress: "192.0.2.1",
			rootPath: join(work, "nas"),
		},
		helperSha256: options.helperSha256, folder, agentPlug: async () => "0e:51:0a:d2:01:0a",
	});
	const router = new code.MachineCommandRouter({
		owner: EXECUTOR, providerId: PROVIDER, peers: [], control,
		credential: async () => {
			throw new Error("P4_NO_PEERS");
		},
		executeLocal: (request, authority, s) =>
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

	// The executor's pass loop, as its timer runs it.
	const outcomes = [];
	const passErrors = [];
	let passing = true;
	const passLoop = (async () => {
		while (passing) {
			try {
				for (const outcome of await host.pass(signal)) {
					const last = outcomes.findLast((o) => o.placementId === outcome.placementId);
					const { t: _t, at: _at, ...was } = last ?? {};
					if (!last || !same(was, outcome)) outcomes.push({ t: elapsed(), at: Date.now(), ...outcome });
					if (outcomes.length > 600) outcomes.splice(0, 100);
				}
			} catch (error) {
				if (passErrors.length < 100) passErrors.push({ t: elapsed(), error: String(error?.message ?? error).slice(0, 300) });
			}
			await sleep(2000).catch(() => undefined);
		}
	})();
	cleanups.push(async () => {
		passing = false;
		await passLoop;
	});
	evidence.service = { ...evidence.service, opens, ops, outcomes, passErrors, rpcCalls: db.calls, rpcFailures: db.failures,
		serviceLog, bridgeLog };

	// The SQL the evidence reads.
	let machineId;
	const views = () =>
		db.json(`select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'state', state, 'bootId', boot_id,
			'placementId', placement_id, 'runId', run_id, 'staffAgentId', staff_agent_id, 'memberUserId', member_user_id,
			'createdAt', created_at, 'closedAt', closed_at, 'closeReason', close_reason) order by created_at), '[]')
			from public.qorpera_folder_views where company_machine_id = ${literal(machineId)}`);
	const commandRows = () =>
		db.json(`select coalesce(jsonb_agg(jsonb_build_object('id', id, 'runId', run_id, 'staffAgentId', staff_agent_id,
			'state', state, 'exitCode', exit_code, 'startedAt', started_at, 'endedAt', ended_at) order by started_at), '[]') from public.qorpera_company_machine_commands where machine_id = ${literal(machineId)}`);
	const commits = () =>
		db.json(`select coalesce(jsonb_agg(jsonb_build_object('seq', c.seq, 'operationKey', c.operation_key,
			'actorKind', c.actor_kind, 'actorId', c.actor_id, 'requesterKind', c.requester_kind, 'requesterId', c.requester_id,
			'runId', c.run_id, 'turnRunId', c.turn_run_id, 'viewId', c.view_id, 'viewKind', c.view_kind,
			'credits', to_jsonb(c.credits), 'units', (select coalesce(jsonb_agg(jsonb_build_object('op', u ->> 'op', 'path', u ->> 'path',
				'credits', u -> 'credits')), '[]') from jsonb_array_elements(c.units) u)) order by c.seq), '[]')
			from public.qorpera_folder_commits c where c.environment_id = ${literal(ENV)} and c.view_id is not null`);
	const entries = (path) =>
		Number(db.query(`select count(*) from public.qorpera_folder_entries where environment_id = ${literal(ENV)}
			and key_text = public.qorpera_folder_key(${literal(path)}) and kind <> 'claim'`));
	const readPaths = (table, column, id) =>
		db.json(`select coalesce(jsonb_agg(distinct x ->> 'path' order by x ->> 'path'), '[]')
			from public.${table} rec, jsonb_array_elements(rec.reads) x where rec.${column} = ${literal(id)}`);
	const commandRow = (id) => commandRows().find((row) => row.id === id);
	const mountedSince = (at) =>
		until(`the folder mounts after ${elapsed()}s`, () => outcomes.find((o) => o.at >= at && o.folder === MOUNTED), {
			timeoutMs: 15 * 60_000, signal,
		});

	// A machine_run as the runtime's tool makes it: its receipt begun over the exact operation the executor rebuilds,
	// the gateway's start with the run's holder, the receipt completed with what came back.
	const machineRun = async (who, key, command, input) => {
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
					arguments: { operationKey: key, machine: MACHINE, command, notify: false },
					target: { realm: "company_machine", machineId }, requiresCompanyRevision: false,
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
		try {
			receipt = await run.gateway.start({ machineId }, startInput, signal);
		} catch (error) {
			refusal = String(error?.message ?? error);
		}
		if (!input)
			await db.rpc("qorpera_complete_native_tool_operation", {
				p_binding: run.binding, p_receipt_id: commandId, p_input_sha256: inputSha256,
				p_result: receipt ?? { error: refusal },
			});
		say(`${who} ${key}: ${receipt ? `start ${receipt.state}` : `refused ${refusal}`}`);
		return { commandId, input: startInput, receipt: receiptOf(receipt), refusal };
	};
	const read = async (who, commandId) => receiptOf(await runs[who].gateway.read({ machineId }, { commandId }, signal));
	const readDone = (who, commandId, timeoutMs = 180_000) =>
		until(`${who}'s command ${commandId} ends`, async () => {
			const receipt = await read(who, commandId);
			return receipt.state === "running" ? null : receipt;
		}, { timeoutMs, signal });

	// 1. A start boots: the host opens the boot's view, the guest's folder-mount mounts /company, and a command reads it.
	const bootAt = Date.now();
	await db.asRun(runs.alice.binding, `p4.mc_observe(${literal(NODE_ID)}, ${literal(nodeSha)}, 16000, 68719476736)`);
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
	const looked = await machineRun("alice", "p4-boot-look", "ls /company; ls /company/p4; cat /company/p4/seed.md");
	steps.boot.command = looked.commandId;
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

	// 4. Reads (before any of Bob's commands): the view's reads, released to Alice's run while her command ran, and taken
	// in by Bob's run (6a-3) through SQL; the runtime's output path that would ask for it (6d-3) is not built.
	steps.reads = { viewId: bootView.id };
	steps.reads.viewReads = readPaths("qorpera_folder_view_read_records", "view_id", bootView.id);
	steps.reads.aliceRunReads = readPaths("qorpera_folder_run_read_records", "run_id", runs.alice.binding.runId);
	steps.reads.bobBefore = readPaths("qorpera_folder_run_read_records", "run_id", runs.bob.binding.runId);
	// The take-in as the run that reads a command's output would make it: Alice's run (her machine's view), and Bob's,
	// whose agent's view it is not (6a-3 lets a company-audience run take it in, and refuses any other).
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

	// 3. Overlap: two runs' commands at once, each change credited to the windows open as it was made.
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
	steps.overlap ={ b: overB.commandId, c: overC.commandId, receipts: { b: receiptB, c: receiptC }, commits: commits() };
	say(`overlap: B ${receiptB.state} C ${receiptC.state}`);

	// 5a. Refusals: a command ended in SQL is refused (the gateway's start again, and its write at the boundary).
	const m = await machineRun("carol", "p4-m", "echo m > /company/p4/m.txt; echo wrote-m");
	const mReceipt = await readDone("carol", m.commandId);
	await until("m.txt is committed and M's end recorded", () => entries("p4/m.txt") === 1 && commandRow(m.commandId)?.endedAt, {
		timeoutMs: 120_000, signal,
	});
	// K writes only after SQL ended it: its window stays open in the service until the guest says K ended, so the write
	// is credited to K, and the service's publish after its quiet period (or the next boundary) sends it.
	const k = await machineRun("bob", "p4-k", "sleep 5; echo k > /company/p4/k.txt; sleep 15; echo k-done");
	const endedAt = Date.now();
	db.query(`do $$ declare m public.qorpera_company_machines;
		begin
			select * into m from public.qorpera_company_machines where id = ${literal(machineId)} for update;
			perform public.qorpera_end_company_machine_commands(m, 'stopped', ${literal([k.commandId])});
		end $$;`);
	const kRow = commandRow(k.commandId);
	const resend = await machineRun("bob", "p4-k", k.input.command, k.input);
	await sleep(8000, undefined, { signal });
	// A boundary after K's write: a read of M, which ended before K started.
	const mAgain = await read("carol", m.commandId);
	// K's unit is answered by a boundary (in its report) or by the quiet period's publish (in the service's log).
	const kReport = await until("k.txt's unit is answered", () => {
		for (const o of ops.filter((x) => x.at >= endedAt && x.answer?.views))
			for (const view of o.answer.views)
				for (const path of view.report?.paths ?? []) if (path.path === "p4/k.txt") return { op: o.op, t: o.t, ...path };
		for (const line of serviceLog) {
			const logged = /^([0-9.]+) .*: p4\/k\.txt: ([a-z_]+)(?: \((.*)\))?$/.exec(line);
			if (logged && Number(logged[1]) * 1000 >= endedAt - started)
				return { op: "quiet", t: Number(logged[1]), path: "p4/k.txt", outcome: logged[2], reason: logged[3] ?? null };
		}
		return null;
	}, { timeoutMs: 90_000, signal }).catch((error) => ({ error: error.message }));
	steps.refusals = {
		m: { commandId: m.commandId, receipt: mReceipt, readAgain: mAgain, entries: entries("p4/m.txt") },
		k: { commandId: k.commandId, start: k.receipt, row: kRow, resend: resend.refusal, report: kReport, entries: entries("p4/k.txt") },
		commits: commits(),
	};
	say(`ended: K ${kRow?.state}; resend ${resend.refusal}; k.txt ${JSON.stringify(kReport)}`);

	// 5b. Another machine in the project, given this view's hand-over, cannot mount it.
	const handover = handovers.at(-1);
	assert(handover?.name === lxdName, "P4: no hand-over of the machine's view was seen");
	secrets.viewPass = JSON.parse(handover.stdin.toString("utf8")).pass;
	const intruder = `qorpera-machine-${randomBytes(16).toString("hex")}`;
	steps.refusals.intruder = { name: intruder };
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
		steps.refusals.intruder.mount = answer?.mount ?? answer?.code ?? null;
		steps.refusals.intruder.opens = opens.filter((o) => o.t >= triedAt && o.machine === intruder);
		steps.refusals.intruder.removed = (await lxc(project, ["delete", "--force", intruder])).status;
	}
	const still = await machineRun("alice", "p4-still", "cat /company/p4/alice.txt");
	steps.refusals.stillReads = await readDone("alice", still.commandId);
	say(`other machine: ${JSON.stringify(steps.refusals.intruder.mount)}; opens ${JSON.stringify(steps.refusals.intruder.opens)}`);

	// 6. Stop: the final boundary, the view closed in SQL, the VM powered off, `restarted`; then a second boot.
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
	say(`stop: view ${steps.stop.view?.state} (${steps.stop.view?.closeReason}); VM ${steps.stop.instanceStatus}`);
	const wakeAt = Date.now();
	steps.stop.wake = { request: await db.asRun(runs.alice.binding, `p4.mc_start('p4-again', ${literal({ machine: MACHINE })})`) };
	await mountedSince(wakeAt);
	steps.stop.wake.mounted = true;
	const wakeView = views().find((v) => v.state === "open");
	steps.stop.wake.view = wakeView;
	steps.stop.wake.bootId = wakeView?.bootId ?? null;
	const again = await machineRun("alice", "p4-again-look", "cat /company/p4/alice.txt /company/p4/carol-after.txt");
	steps.stop.wake.receipt = await readDone("alice", again.commandId);
	say(`wake: view ${wakeView?.id} boot ${wakeView?.bootId}; read ${JSON.stringify(steps.stop.wake.receipt.output)}`);

	evidence.sql = { views: views(), commands: commandRows(), commits: commits() };
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
