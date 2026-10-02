#!/usr/bin/env node
// Rolling update packets (identical nodes change 7, rolling step 2; RUNTIME-ROLLING-UPDATE.md).
//
// Writes one directory of SQL packets for the coordinator's packet runner: every file is exactly one
// outer transaction, its digest is in packet.json, and the check packets are dry-run only (they read
// operator functions, which a read-only role cannot run). Nothing here connects to a database.
//
//   node scripts/runtime-roll.mjs packets --ref <release commit> --activation <file> [--migration <file> ...]
//     --from-version <N> --from-sha <sha> --to-version <N+1> --to-sha <sha> --node-a <uuid> --node-b <uuid>
//     --reason <text> --out <new directory> [--repo <checkout>] [--empty runs|full]
//   node scripts/runtime-roll.mjs compare <check result.json> <later check result.json>
//
// --empty full switches each node off fully while it empties (a release that also changes its office
// provider or coding executor); the default stops only runs and sign-ins. A node returns with both on.
// Packets, in order (node A is emptied and updated first, then node B; node A must be no home of a
// node-disk login, which 00-check enforces):
//   00-check          dry-run only: preflight; prints the gates, the node-disk logins and N's pending inputs
//   10-migration-*    one per release migration, gated on N being active; no pause
//   20-declare-b      node B's orchestrators declared N
//   30-runs-off-a     node A takes no new runs (machines carry on)
//   31-drain-a        dry-run only: node A's drain status (wait for readyForNodeRelease)
//   40-switch         one transaction: gates, activation, its history record, node A declared N+1, gate, node A runs on
//   50-check-n        dry-run only: N work still queued, running or pending (compare with 00-check's inputs)
//   60-runs-off-b     node B takes no new runs
//   61-drain-b        dry-run only: node B's drain status
//   70-return-b       node B declared N+1, gate, node B runs on
//   80-finish         every declaration cleared, both nodes serving runs
//   90-pause-now      emergency only: every company paused, with no quiet gate
//   91-reverse        emergency only: the active bundle back to N, declarations cleared (after 90)
//   92-resume         emergency only: the companies 90 paused resume
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const MIGRATION_NAME = /^(\d{14})_([a-z0-9_]+)\.sql$/;

/** Top-level statements of a SQL text: [start, end, masked text]. Literals, comments and dollar bodies are
 * masked, so a semicolon or transaction keyword inside them is never a statement (sql_packet.py's rules). */
export function statements(sql) {
	const mask = sql.split("");
	let i = 0;
	const n = sql.length;
	while (i < n) {
		let end;
		if (sql.startsWith("--", i)) {
			end = sql.indexOf("\n", i);
			if (end < 0) end = n;
		} else if (sql.startsWith("/*", i)) {
			let j = i + 2;
			let depth = 1;
			while (j < n && depth) {
				if (sql.startsWith("/*", j)) {
					depth++;
					j += 2;
				} else if (sql.startsWith("*/", j)) {
					depth--;
					j += 2;
				} else j++;
			}
			if (depth) throw new Error("Unterminated SQL comment");
			end = j;
		} else if (sql[i] === "'" || sql[i] === '"') {
			const quote = sql[i];
			const escaped = quote === "'" && i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[A-Za-z0-9_]/.test(sql[i - 2]));
			let j = i + 1;
			let closed = false;
			while (j < n) {
				if (escaped && sql[j] === "\\") j += 2;
				else if (sql[j] === quote) {
					if (sql[j + 1] === quote) j += 2;
					else {
						j++;
						closed = true;
						break;
					}
				} else j++;
			}
			if (!closed) throw new Error("Unterminated SQL literal");
			end = j;
		} else if (sql[i] === "$") {
			const match = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i));
			if (match) {
				const close = sql.indexOf(match[0], i + match[0].length);
				if (close < 0) throw new Error("Unterminated SQL dollar body");
				end = close + match[0].length;
			}
		}
		if (end !== undefined) {
			for (let k = i; k < end; k++) mask[k] = " ";
			i = end;
		} else i++;
	}
	const masked = mask.join("");
	const result = [];
	let start = 0;
	for (let k = 0; k < masked.length; k++) {
		if (masked[k] !== ";") continue;
		const clean = masked.slice(start, k).trim();
		if (clean) result.push([start, k + 1, clean]);
		start = k + 1;
	}
	if (masked.slice(start).trim()) throw new Error("Unterminated top-level SQL statement");
	return result;
}

const CONTROL = /^(?:begin|commit|rollback|end|abort|start\s+transaction|prepare\s+transaction|savepoint|release\s+savepoint)\b/i;
/** A migration's text to run inside a packet's own transaction: one optional outer begin/commit is removed.
 * Other transaction control, and statements that cannot run in a transaction, are refused (such a release
 * applies that migration by hand, as rehearsed, or pauses). */
export function migrationBody(sql) {
	const parts = statements(sql);
	for (const [, , clean] of parts) {
		if (/^(?:create|drop)\s+(?:unique\s+)?index\s+concurrently\b/i.test(clean) || /^(?:vacuum|reindex\s+.*concurrently)\b/i.test(clean))
			throw new Error("A statement that cannot run in a transaction: apply this migration on its own");
	}
	const controls = parts.map((p, index) => [index, p]).filter(([, p]) => CONTROL.test(p[2]));
	if (!controls.length) return sql;
	if (
		controls.length !== 2 ||
		controls[0][0] !== 0 ||
		controls[1][0] !== parts.length - 1 ||
		controls[0][1][2].toLowerCase() !== "begin" ||
		controls[1][1][2].toLowerCase() !== "commit"
	)
		throw new Error("Unsafe transaction control: at most one outer BEGIN/COMMIT is allowed");
	return sql.slice(parts[0][1], parts.at(-1)[0]);
}

export const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
function dollar(text) {
	let tag;
	do tag = `$roll_${randomBytes(6).toString("hex")}$`;
	while (text.includes(tag));
	return `${tag}${text}${tag}`;
}

const SERVICE = `select set_config('request.jwt.claims','{"role":"service_role"}',true);`;
const ORCHESTRATORS_ON = (node) =>
	`select orchestrator.* from public.qorpera_runner_orchestrators orchestrator where orchestrator.status <> 'revoked'
	and exists (select 1 from public.qorpera_runtime_node_providers provider where provider.provider_kind = 'native'
		and provider.provider_id = orchestrator.provider_adapter and provider.node_id = ${literal(node)}::uuid)`;
const ACTIVE_IS = (version, sha) =>
	`exists (select 1 from public.qorpera_active_runtime_bundle a join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id
		where a.singleton and b.bundle_key = 'qorpera.cloud-runtime' and b.version = ${version} and b.sha256 = ${literal(sha)} and a.runtime_bundle_sha256 = b.sha256)`;
const NODE_READY = (node) =>
	`exists (select 1 from public.qorpera_runtime_nodes n join public.qorpera_runtime_node_observations o on o.node_id = n.id
		where n.id = ${literal(node)}::uuid and o.observation ->> 'state' = 'ready' and o.observed_at > statement_timestamp() - interval '60 seconds'
			and public.qorpera_runtime_node_inventory_ready(n.id, o.observation_id, n.version))`;
const RUNS_ON = (node) => `(select enabled and runs_enabled from public.qorpera_runtime_nodes where id = ${literal(node)}::uuid)`;
/** The markers the roll relies on (RUNTIME-ROLLING-UPDATE.md step 2), plus rolling step 1's functions. */
const MARKERS = `select not exists (select 1 from (values
		('qorpera_runtime_orchestrator_nodes(v_adapter)', 'public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'),
		('declared.runtime_bundle_sha256', 'public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'),
		('qorpera_runtime_claim_turn(p_orchestrator_id, job, run)', 'public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'),
		('orchestrator.runtime_bundle_sha256 = p_run.runtime_bundle_sha256', 'public.qorpera_runtime_run_placement(public.qorpera_runner_jobs,public.qorpera_execution_runs)'),
		('node.enabled and node.runs_enabled', 'public.qorpera_runtime_orchestrator_nodes(text)'),
		('or n.runs_enabled)', 'public.qorpera_runtime_node_placement_candidates(text)'),
		('p_provider_kind in (''native'',''login'')))', 'public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'),
		('qorpera_runtime_adapter_takes_bundle', 'public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid,uuid,text)'),
		('v_run.runtime_bundle_sha256);', 'public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)')
	) m(marker, fn) where to_regprocedure(m.fn) is null or position(m.marker in pg_get_functiondef(to_regprocedure(m.fn))) = 0)`;
// The logins still on a node disk, with their home nodes: their runs can run only there.
const NODE_DISK_LOGINS = `select coalesce(jsonb_agg(jsonb_build_object('computeIdentityId', l.id, 'homes', l.homes) order by l.id), '[]'::jsonb)
	from (select distinct c.compute_identity_id id, public.qorpera_runtime_login_identity_homes(c.compute_identity_id) homes
		from public.qorpera_native_credential_capsules c
		where c.status = 'active' and not public.qorpera_compute_identity_login_in_vault(c.compute_identity_id)) l`;
const NO_LOGIN_HOME = (node) =>
	`not exists (select 1 from public.qorpera_native_credential_capsules c where c.status = 'active'
		and not public.qorpera_compute_identity_login_in_vault(c.compute_identity_id)
		and ${literal(node)}::uuid = any(public.qorpera_runtime_login_identity_homes(c.compute_identity_id)))`;
const N_PENDING = (sha) =>
	`select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'sessionId', i.session_id, 'createdAt', i.created_at) order by i.created_at, i.id), '[]'::jsonb)
	from public.qorpera_session_inputs i where i.completed_at is null and i.failed_at is null and i.execution_run_id is null
		and i.turn_id is null and i.runtime_bundle_sha256 = ${literal(sha)}`;

function packet(lines) {
	return `begin;\nset local lock_timeout = '5s';\nset local statement_timeout = '120s';\n${lines.join("\n")}\ncommit;\n`;
}
function gate(name, checks) {
	const body = checks.map(([condition, message]) => `\tif not coalesce((${condition}), false) then raise exception ${literal(message)}; end if;`);
	return `do $${name}$ begin\n${body.join("\n")}\nend $${name}$;`;
}

function historyInsert(name, text) {
	const [, version, label] = MIGRATION_NAME.exec(name);
	return `insert into supabase_migrations.schema_migrations(version,name,statements) values (${literal(version)},${literal(label)},array[${dollar(text)}]);`;
}
const NOT_RECORDED = (name) => [
	`not exists (select 1 from supabase_migrations.schema_migrations where version = ${literal(MIGRATION_NAME.exec(name)[1])})`,
	`${name} is already recorded; inspect receipts instead of replaying`,
];
const RECORDED = (name) => [
	`exists (select 1 from supabase_migrations.schema_migrations where version = ${literal(MIGRATION_NAME.exec(name)[1])})`,
	`${name} is not recorded yet`,
];

/** Every packet of one roll, by file name. */
export function rollPackets(options) {
	const { activation, migrations = [], from, to, nodeA, nodeB, reason, empty = "runs" } = options;
	if (empty !== "runs" && empty !== "full") throw new Error("--empty is runs or full");
	const ready = empty === "full" ? "readyForUpdate" : "readyForNodeRelease";
	if (!UUID.test(nodeA) || !UUID.test(nodeB) || nodeA === nodeB) throw new Error("Two different node ids are required");
	if (!SHA.test(from.sha) || !SHA.test(to.sha) || from.sha === to.sha) throw new Error("Two different bundle digests are required");
	if (!Number.isSafeInteger(from.version) || to.version !== from.version + 1) throw new Error("The new bundle is the next version");
	if (!reason || reason.length > 200 || /[\0\r\n]/.test(reason)) throw new Error("A one-line reason of at most 200 characters is required");
	if (!MIGRATION_NAME.test(activation.name)) throw new Error("Activation file name is not a migration name");
	if (
		!new RegExp(`values \\('qorpera\\.cloud-runtime',${to.version},`).test(activation.text) ||
		!activation.text.includes(`b.version=${from.version}`) ||
		!activation.text.includes(`'${from.sha}'`)
	)
		throw new Error(`Activation does not move ${from.version} to ${to.version}`);
	if (/\b(update|delete\s+from)\s+public\.(qorpera_execution_runs|qorpera_session_inputs)\b/i.test(activation.text))
		throw new Error("Activation touches historical provenance");
	const activationBody = migrationBody(activation.text);
	for (const migration of migrations) {
		if (!MIGRATION_NAME.test(migration.name) || migration.name >= activation.name)
			throw new Error(`${migration.name} is no migration that sorts before the activation`);
		if (/runtime_bundle_activation/.test(migration.name)) throw new Error("Only one activation per roll");
	}
	const files = {};
	const nodes = `jsonb_build_object('a', public.qorpera_runtime_node_drain_status(${literal(nodeA)}::uuid), 'b', public.qorpera_runtime_node_drain_status(${literal(nodeB)}::uuid))`;
	const hard = [
		[ACTIVE_IS(from.version, from.sha), `Runtime ${from.version} is not the active bundle`],
		[`${RUNS_ON(nodeA)} and ${RUNS_ON(nodeB)}`, "Both nodes must serve runs"],
		[`${NODE_READY(nodeA)} and ${NODE_READY(nodeB)}`, "Both nodes must be observed ready"],
		[
			`not exists (select 1 from public.qorpera_runner_orchestrators o where o.status <> 'revoked' and (select count(distinct p.node_id) from public.qorpera_runtime_node_providers p where p.provider_kind = 'native' and p.provider_id = o.provider_adapter) <> 1)`,
			"Every orchestrator maps to exactly one node",
		],
		[`not exists (select 1 from public.qorpera_node_update_targets where resumed_version is null)`, "A signed node update is unfinished"],
		[`not exists (select 1 from public.qorpera_runner_orchestrators where status <> 'revoked' and runtime_bundle_sha256 is not null)`, "An orchestrator declares a bundle"],
		[MARKERS, "A guard the roll relies on is missing"],
		[NO_LOGIN_HOME(nodeA), "Node A is the home of a node-disk login: empty the other node first"],
	];
	const check = (title, rows) => packet([SERVICE, `select jsonb_build_object(${rows.join(", ")}) as ${title};`]);
	files["00-check.sql"] = check("roll_check", [
		`'ok', ${hard.map(([condition]) => `coalesce((${condition}), false)`).join(" and ")}`,
		`'failures', (select coalesce(jsonb_agg(f.message), '[]'::jsonb) from (values ${hard.map(([condition, message]) => `(coalesce((${condition}), false), ${literal(message)})`).join(", ")}) f(ok, message) where not f.ok)`,
		`'nodes', ${nodes}`,
		`'rollStatus', public.qorpera_runtime_bundle_roll_status()`,
		`'nodeDiskLogins', (${NODE_DISK_LOGINS})`,
		`'pendingInputs', (${N_PENDING(from.sha)})`,
	]);
	for (const migration of migrations) {
		const body = migrationBody(migration.text);
		files[`10-migration-${migration.name}`] = packet([
			gate("roll_gate", [[ACTIVE_IS(from.version, from.sha), `Runtime ${from.version} is not the active bundle`], NOT_RECORDED(migration.name)]),
			body,
			historyInsert(migration.name, body),
			`select jsonb_build_object('migration', ${literal(migration.name)}, 'recorded', true) as roll_migration;`,
		]);
	}
	const declared = (node, sha) =>
		`not exists (${ORCHESTRATORS_ON(node)} and orchestrator.runtime_bundle_sha256 is distinct from ${literal(sha)})`;
	files["20-declare-b.sql"] = packet([
		SERVICE,
		gate("roll_gate", [[ACTIVE_IS(from.version, from.sha), `Runtime ${from.version} is not the active bundle`], ...migrations.map((m) => RECORDED(m.name))]),
		`select public.qorpera_declare_runtime_node_bundle(${literal(nodeB)}::uuid, ${literal(from.sha)}) as roll_declare;`,
		gate("roll_after", [[declared(nodeB, from.sha), "Node B is not declared for the running bundle"]]),
	]);
	const version = (node) => `(select version from public.qorpera_runtime_nodes where id = ${literal(node)}::uuid)`;
	const runs = (node, on) =>
		`select public.qorpera_set_runtime_node_runs(${literal(node)}::uuid, ${on}, ${version(node)}, ${literal(reason)}) as roll_runs;`;
	const serving = (node, on) =>
		`select public.qorpera_set_runtime_node_serving(${literal(node)}::uuid, ${on}, ${version(node)}, ${literal(reason)}) as roll_serving;`;
	// Emptying: the runs switch, or the full switch too. Returning: both switches on, whichever was used.
	const off = (node) => (empty === "full" ? [runs(node, false), serving(node, false)] : [runs(node, false)]);
	const back = (node) => [serving(node, true), runs(node, true)];
	files["30-runs-off-a.sql"] = packet([SERVICE, ...off(nodeA)]);
	const drain = (node) =>
		check("roll_drain", [`'status', public.qorpera_runtime_node_drain_status(${literal(node)}::uuid)`, `'rollStatus', public.qorpera_runtime_bundle_roll_status()`]);
	files["31-drain-a.sql"] = drain(nodeA);
	const live = (node) => [
		`not exists (${ORCHESTRATORS_ON(node)} and orchestrator.status = 'active' and orchestrator.last_heartbeat_at < statement_timestamp() - interval '30 seconds')`,
		`An orchestrator of ${node === nodeA ? "node A" : "node B"} is not running`,
	];
	const undeclaredOnlyOn = (node) =>
		`not exists (select 1 from public.qorpera_runner_orchestrators o where o.status <> 'revoked' and o.runtime_bundle_sha256 is null
			and not exists (select 1 from public.qorpera_runtime_node_providers p where p.provider_kind = 'native' and p.provider_id = o.provider_adapter and p.node_id = ${literal(node)}::uuid))`;
	files["40-switch.sql"] = packet([
		SERVICE,
		gate("roll_gate", [
			[ACTIVE_IS(from.version, from.sha), `Runtime ${from.version} is not the active bundle`],
			...migrations.map((m) => RECORDED(m.name)),
			NOT_RECORDED(activation.name),
			[MARKERS, "A guard the roll relies on is missing"],
			[declared(nodeB, from.sha), "Node B is not declared for the running bundle"],
			[undeclaredOnlyOn(nodeA), "An undeclared orchestrator outside node A could take the new bundle on old code"],
			[`not ${RUNS_ON(nodeA)}`, "Node A must have runs off"],
			live(nodeA),
			[NODE_READY(nodeA), "Node A is not observed ready"],
			[NO_LOGIN_HOME(nodeA), "Node A became the home of a node-disk login: its N runs could not run anywhere"],
		]),
		activationBody,
		historyInsert(activation.name, activationBody),
		`select public.qorpera_declare_runtime_node_bundle(${literal(nodeA)}::uuid, ${literal(to.sha)}) as roll_declare;`,
		gate("roll_after", [
			[ACTIVE_IS(to.version, to.sha), `Runtime ${to.version} is not the active bundle after the activation`],
			[declared(nodeA, to.sha), "Node A is not declared for the new bundle"],
			[`not exists (select 1 from public.qorpera_runner_orchestrators where status <> 'revoked' and runtime_bundle_sha256 is null)`, "An orchestrator is undeclared"],
		]),
		...back(nodeA),
		`select public.qorpera_runtime_bundle_roll_status() as roll_switched;`,
	]);
	files["50-check-n.sql"] = check("roll_check_n", [
		`'rollStatus', public.qorpera_runtime_bundle_roll_status()`,
		`'pendingInputs', (${N_PENDING(from.sha)})`,
		`'nodes', ${nodes}`,
	]);
	files["60-runs-off-b.sql"] = packet([
		SERVICE,
		gate("roll_gate", [[ACTIVE_IS(to.version, to.sha), `Runtime ${to.version} is not the active bundle`], [RUNS_ON(nodeA), "Node A must serve runs first"]]),
		...off(nodeB),
	]);
	files["61-drain-b.sql"] = drain(nodeB);
	files["70-return-b.sql"] = packet([
		SERVICE,
		gate("roll_gate", [
			[ACTIVE_IS(to.version, to.sha), `Runtime ${to.version} is not the active bundle`],
			[`(public.qorpera_runtime_node_drain_status(${literal(nodeB)}::uuid) ->> ${literal(ready)})::boolean`, "Node B is not emptied of runs"],
			live(nodeB),
			[NODE_READY(nodeB), "Node B is not observed ready"],
		]),
		`select public.qorpera_declare_runtime_node_bundle(${literal(nodeB)}::uuid, ${literal(to.sha)}) as roll_declare;`,
		gate("roll_after", [
			[declared(nodeB, to.sha), "Node B is not declared for the new bundle"],
			[`not exists (select 1 from public.qorpera_runner_orchestrators where status <> 'revoked' and runtime_bundle_sha256 = ${literal(from.sha)})`, "An orchestrator still declares the old bundle"],
		]),
		...back(nodeB),
	]);
	files["80-finish.sql"] = packet([
		SERVICE,
		gate("roll_gate", [
			[ACTIVE_IS(to.version, to.sha), `Runtime ${to.version} is not the active bundle`],
			[`${RUNS_ON(nodeA)} and ${RUNS_ON(nodeB)}`, "Both nodes must serve runs"],
			[
				`not exists (select 1 from public.qorpera_runner_jobs job join public.qorpera_execution_runs run on run.id = job.run_id where job.status in ('queued','leased','running') and run.runtime_bundle_sha256 = ${literal(from.sha)})`,
				"Work of the old bundle is still queued or running",
			],
		]),
		`select public.qorpera_declare_runtime_node_bundle(${literal(nodeA)}::uuid, null) as roll_clear_a;`,
		`select public.qorpera_declare_runtime_node_bundle(${literal(nodeB)}::uuid, null) as roll_clear_b;`,
		`select public.qorpera_runtime_bundle_roll_status() as roll_finished;`,
	]);
	// Emergency: pause without a quiet gate (today's pause refuses unless nothing runs), reverse, resume.
	// The company stop is a founder's call: each company is paused under one of its owners or admins. A
	// folder-v2 company or one without an owner or admin cannot be stopped this way; the result names them.
	const PAUSABLE = `not public.qorpera_company_is_folder_v2(profile.id) and exists (select 1 from public.qorpera_profile_members member
			where member.profile_id = profile.id and member.role in ('owner','admin'))`;
	const founders = (paused) => `do $roll_pause$
declare v_company record;
begin
	for v_company in
		select profile.id, (select member.user_id from public.qorpera_profile_members member
			where member.profile_id = profile.id and member.role in ('owner','admin') order by member.role = 'owner' desc, member.user_id limit 1) founder
		from public.qorpera_profiles profile
		where ${PAUSABLE}
			and ${paused ? "not exists (select 1 from public.qorpera_company_execution_pauses p where p.profile_id = profile.id)" : `exists (select 1 from public.qorpera_company_execution_pauses p where p.profile_id = profile.id and p.reason = ${literal(reason)})`}
		order by profile.id
	loop
		perform set_config('request.jwt.claims', jsonb_build_object('sub', v_company.founder, 'role', 'authenticated')::text, true);
		perform public.qorpera_set_company_execution_pause(v_company.id, ${paused}, ${paused ? literal(reason) : "null"});
	end loop;
end $roll_pause$;`;
	files["90-pause-now.sql"] = packet([
		founders(true),
		`select jsonb_build_object('paused', (select count(*) from public.qorpera_company_execution_pauses where reason = ${literal(reason)}),
	'notPaused', (select coalesce(jsonb_agg(profile.id order by profile.id), '[]'::jsonb) from public.qorpera_profiles profile
		where not exists (select 1 from public.qorpera_company_execution_pauses p where p.profile_id = profile.id))) as roll_paused;`,
	]);
	files["91-reverse.sql"] = packet([
		gate("roll_gate", [
			[ACTIVE_IS(to.version, to.sha), `Runtime ${to.version} is not the active bundle`],
			[
				`not exists (select 1 from public.qorpera_profiles profile where ${PAUSABLE} and not exists (select 1 from public.qorpera_company_execution_pauses p where p.profile_id = profile.id))`,
				"Every company that can be paused must be paused first (90-pause-now)",
			],
		]),
		`update public.qorpera_active_runtime_bundle set runtime_bundle_id = b.id, runtime_bundle_sha256 = b.sha256, activated_at = statement_timestamp()
from public.qorpera_runtime_bundles b where singleton and b.bundle_key = 'qorpera.cloud-runtime' and b.version = ${from.version} and b.sha256 = ${literal(from.sha)};`,
		gate("roll_after", [[ACTIVE_IS(from.version, from.sha), `Runtime ${from.version} is not active again`]]),
		SERVICE,
		`select public.qorpera_declare_runtime_node_bundle(${literal(nodeA)}::uuid, null) as roll_clear_a;`,
		`select public.qorpera_declare_runtime_node_bundle(${literal(nodeB)}::uuid, null) as roll_clear_b;`,
	]);
	files["92-resume.sql"] = packet([
		founders(false),
		`select jsonb_build_object('stillPaused', (select count(*) from public.qorpera_company_execution_pauses where reason = ${literal(reason)})) as roll_resumed;`,
	]);
	for (const [name, text] of Object.entries(files)) assertOneTransaction(name, text);
	return files;
}

/** The packet runner's rule: exactly one outer BEGIN/COMMIT and no other transaction control. */
export function assertOneTransaction(name, text) {
	const parts = statements(text);
	const controls = parts.filter((p) => CONTROL.test(p[2]));
	if (controls.length !== 2 || parts[0][2].toLowerCase() !== "begin" || parts.at(-1)[2].toLowerCase() !== "commit")
		throw new Error(`${name} is not exactly one outer transaction`);
}

export const DRY_RUN_ONLY = ["00-check.sql", "31-drain-a.sql", "50-check-n.sql", "61-drain-b.sql"];

/** The packet directory: files plus packet.json (digests, order, dry-run-only files). */
export function writeRoll(out, options) {
	if (existsSync(out)) throw new Error(`${out} exists; packets are written once`);
	const files = rollPackets(options);
	mkdirSync(out, { recursive: true });
	const digests = {};
	for (const [name, text] of Object.entries(files)) {
		writeFileSync(join(out, name), text, { flag: "wx" });
		digests[name] = createHash("sha256").update(text).digest("hex");
	}
	const manifest = {
		schema: "qorpera.runtime-roll-packet/v1",
		from: options.from,
		to: options.to,
		nodes: { a: options.nodeA, b: options.nodeB },
		reason: options.reason,
		empty: options.empty ?? "runs",
		source: options.source ?? null,
		order: Object.keys(files),
		dryRunOnly: DRY_RUN_ONLY,
		emergencyOnly: ["90-pause-now.sql", "91-reverse.sql", "92-resume.sql"],
		files: digests,
	};
	writeFileSync(join(out, "packet.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
	return manifest;
}

/** N inputs pending now that were not pending at 00-check (live N work: let node B run it). */
export function newPendingInputs(before, after) {
	const ids = new Set(before.map((input) => input.id));
	return after.filter((input) => !ids.has(input.id));
}
function rowsOf(file, key) {
	const value = JSON.parse(readFileSync(file, "utf8"));
	const rows = Array.isArray(value) ? value : value.result;
	const row = rows?.find((item) => item && typeof item === "object" && key in item)?.[key];
	if (!row) throw new Error(`${file} holds no ${key} row`);
	return typeof row === "string" ? JSON.parse(row) : row;
}

function parseArgs(argv) {
	const options = { migration: [] };
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i];
		if (!key.startsWith("--")) throw new Error(`Unexpected ${key}`);
		const value = argv[++i];
		if (value === undefined) throw new Error(`${key} needs a value`);
		const name = key.slice(2);
		if (name === "migration") options.migration.push(value);
		else options[name] = value;
	}
	return options;
}

async function main(argv) {
	const [command, ...rest] = argv;
	if (command === "compare") {
		const [before, after] = rest;
		if (!before || !after || rest.length !== 2) throw new Error("Usage: compare <00-check result> <50-check-n result>");
		const fresh = newPendingInputs(rowsOf(before, "roll_check").pendingInputs, rowsOf(after, "roll_check_n").pendingInputs);
		process.stdout.write(`${JSON.stringify({ newPendingInputs: fresh }, null, 2)}\n`);
		return fresh.length ? 1 : 0;
	}
	if (command !== "packets") throw new Error("Usage: runtime-roll.mjs packets … | compare …");
	const o = parseArgs(rest);
	const repo = resolve(o.repo ?? ".");
	if (!o.ref || !o.activation || !o.out) throw new Error("--ref, --activation and --out are required");
	const show = (name) =>
		execFileSync("git", ["-C", repo, "show", `${o.ref}:supabase/migrations/${name}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const commit = execFileSync("git", ["-C", repo, "rev-parse", `${o.ref}^{commit}`], { encoding: "utf8" }).trim();
	const manifest = writeRoll(resolve(o.out), {
		activation: { name: basename(o.activation), text: show(basename(o.activation)) },
		migrations: o.migration.map((name) => ({ name: basename(name), text: show(basename(name)) })),
		from: { version: Number(o["from-version"]), sha: o["from-sha"] },
		to: { version: Number(o["to-version"]), sha: o["to-sha"] },
		nodeA: o["node-a"],
		nodeB: o["node-b"],
		reason: o.reason,
		empty: o.empty ?? "runs",
		source: { commit },
	});
	process.stdout.write(`${JSON.stringify({ out: resolve(o.out), order: manifest.order }, null, 2)}\n`);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 2;
		},
	);
}
