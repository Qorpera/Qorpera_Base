// Replays exact wrappers in an isolated disposable database. No Supabase CLI,
// live data, provider, host mount, network or production transport is used.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import baseline from "./rehearsal-baseline.json" with { type: "json" };
import { FIXED as F, INPUT, MUTATIONS, ROOT, STEPS, classifyReconciliation, hash, need, validateReadback } from "./contract.mjs";
import { PACKET_SHA256, READY, RELEASE_PINS, checkPacket } from "./controller.mjs";
import { assertAbsent, readTrusted, writeExclusive } from "./files.mjs";

const IMAGE = "public.ecr.aws/supabase/postgres@sha256:28f0e16a019e648089fc1a6d333549a55548f6019c15ae4bd7cd58b989027518";
const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
const policyWhere = "provider='openai' and authentication_mode='native_subscription' and native_harness='codex-cli'";

export async function rehearseWrapper(schemaPath) {
	need(typeof schemaPath === "string" && isAbsolute(schemaPath) && resolve(schemaPath) === schemaPath, "SCHEMA_PATH_REJECTED");
	assertAbsent(join(ROOT, "WRAPPER-REHEARSAL.json"));
	need(!READY && Object.values(RELEASE_PINS).every((value) => value === null), "PACKET_MUST_REMAIN_DISABLED");
	const packet = checkPacket();
	const schema = readTrusted(schemaPath, 32 * 1024 * 1024);
	need(hash(schema) === baseline.schemaSha256 && baseline.schema === "qorpera.rehearsal-schema-baseline/v1", "SCHEMA_PIN_REJECTED");
	need(baseline.baselineVersions.length === 92 && baseline.baselineVersions.every((version) => INPUT.baselineVersions.includes(version))
		&& JSON.stringify(baseline.productionOnly) === JSON.stringify(INPUT.productionOnly), "SCHEMA_BASELINE_REJECTED");
	const migrationNames = readdirSync(join(F.source, "supabase/migrations")).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
	const beforeMigrations = migrationNames.filter((name) => INPUT.baselineVersions.includes(name.slice(0, 14)) && !baseline.baselineVersions.includes(name.slice(0, 14)));
	need(beforeMigrations.length + baseline.baselineVersions.length === INPUT.baselineVersions.length, "BASELINE_RECONSTRUCTION_REJECTED");
	const container = `qorpera-wrapper-${randomBytes(6).toString("hex")}`, volume = `${container}-data`;
	const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1"];
	function docker(args, input, reject = false) {
		const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
		if (reject) {
			need(!result.error && result.status !== 0 && /(?:LEDGER|POLICY)_PRESTATE_REJECTED/.test(result.stderr), "REPLAY_NOT_REJECTED");
			return;
		}
		need(!result.error && result.status === 0, `DISPOSABLE_DATABASE_FAILED: ${result.stderr?.split("\n").find((line) => line.startsWith("ERROR:")) ?? "command unavailable"}`);
		return result.stdout.trim();
	}
	const sql = Object.fromEntries(Object.entries(packet.sql).map(([name, pin]) => {
		const bytes = readTrusted(join(ROOT, "sql", name)); need(hash(bytes) === pin.sha256, "SQL_CHANGED"); return [name, bytes];
	}));
	function readback(name, step) {
		const lines = docker(psql, sql[name]).split("\n").filter(Boolean);
		need(lines.length === 1, "READBACK_COUNT_REJECTED");
		const value = JSON.parse(lines[0]);
		if (step) validateReadback(value, step);
		return { value, sha256: hash(Buffer.from(`${lines[0]}\n`)) };
	}
	let created = false, started = false, passed = false;
	const results = [];
	try {
		docker(["volume", "create", "--label", "qorpera.test=runtime-rollout", volume]); created = true;
		docker(["run", "--pull", "never", "--network", "none", "-d", "--rm", "--name", container,
			"--label", "qorpera.test=runtime-rollout", "-e", "POSTGRES_PASSWORD=qorpera-test-only", "-e", "POSTGRES_DB=postgres",
			"--mount", `type=volume,source=${volume},target=/var/lib/postgresql/data`, IMAGE]); started = true;
		let ready = 0;
		for (let attempt = 0; attempt < 100 && ready < 2; attempt++) {
			const check = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres"], { timeout: 2000 });
			ready = check.status === 0 ? ready + 1 : 0;
			if (ready < 2) await new Promise((done) => setTimeout(done, 500));
		}
		need(ready === 2, "DISPOSABLE_DATABASE_NOT_READY");
		docker(psql, "drop schema if exists supabase_migrations cascade; drop schema if exists auth cascade; drop schema if exists storage cascade; drop schema if exists public cascade;");
		docker(psql, schema);
		// The old snapshot preserves the 18 production-only schema changes.
		// Advance its known baseline using exactly the candidate's shipped files.
		for (const name of beforeMigrations) docker(psql, readTrusted(join(F.source, "supabase/migrations", name)));
		const workspace = randomUUID();
		docker(psql, `
			create schema if not exists supabase_migrations authorization supabase_admin;
			create table supabase_migrations.schema_migrations(version text primary key,name text not null,statements text[] not null);
			insert into supabase_migrations.schema_migrations(version,name,statements) values
			${INPUT.baselineVersions.map((version) => `(${q(version)},${q(`captured_${version}`)},array['captured'])`).join(",")};
			begin;
			-- Synthetic readback metadata only. No native admission, credential,
			-- execution, consent or authority function is faked by this seed.
			set local session_replication_role=replica;
			insert into auth.users(id,email) values(${q(F.owner)},'owner@company41.invalid');
			insert into public.qorpera_profiles(id,name,created_by_user_id) values(${q(F.company)},'Company41',${q(F.owner)});
			insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
			values(${q(F.company)},${q(F.owner)},'owner@company41.invalid','Owner','owner');
			insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
			values(${q(F.environment)},${q(F.company)},'Company41',2,${q(F.owner)});
			insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,parent_snapshot_id,
				tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
			values(${q(F.head)},${q(F.company)},${q(F.environment)},${q(workspace)},${q(randomUUID())},null,
				${q(F.tree)},1,3,${F.fileCount},${F.totalBytes},${q(F.owner)});
			insert into public.qorpera_company_files(environment_id,profile_id,canonical_workspace_id,head_snapshot_id,state,logical_bytes,
				storage_used_bytes,storage_limit_bytes,created_by_user_id,path_gateway_version,path_index_snapshot_id)
			values(${q(F.environment)},${q(F.company)},${q(workspace)},${q(F.head)},'ready',${F.totalBytes},${F.totalBytes},53687091200,${q(F.owner)},1,${q(F.head)});
			insert into public.qorpera_member_compute_identities(id,profile_id,ownership_kind,owner_user_id,owner_scope_key,client_identity_id,display_name,
				template_key,template_version,capabilities,policy,encrypted_profile_reference,encrypted_overlay_reference,status)
			values(${q(F.identity)},${q(F.company)},'company',null,null,${q(F.clientIdentity)},'Company41 runtime','qorpera-member-linux','v1',
				'["agent_turn","company_substrate"]','{}',null,null,'active');
			insert into public.qorpera_logical_computers(id,profile_id,client_computer_id,display_name,template_key,template_version,capabilities,policy,
				encrypted_volume_object_sha256,status,created_by_user_id,compute_identity_id,computer_class)
			values(${q(F.logical)},${q(F.company)},${q(randomUUID())},'Legacy Company Computer','legacy-company-computer','v1',
				'["agent_turn","company_substrate"]','{}',null,'retired',${q(F.owner)},${q(F.identity)},'company_computer');
			insert into public.qorpera_company_computers(id,profile_id,environment_id,logical_computer_id,node_id,migration_target_node_id,nas_dataset,lifecycle_state,created_by_user_id)
			values(${q(F.registry)},${q(F.company)},${q(F.environment)},${q(F.logical)},${q(randomUUID())},null,'companies/company41','retired',${q(F.owner)});
			insert into public.qorpera_provider_execution_policies(provider,authentication_mode,native_harness,implementation_status,enablement_status,max_native_concurrency,policy_version,disabled_reason)
			values('openai','native_subscription','codex-cli','supported',${q(F.initialEnablement)},${F.concurrency},${F.policyVersionBefore},${F.initialReason === null ? "null" : q(F.initialReason)})
			on conflict(provider,authentication_mode,native_harness) do update set implementation_status=excluded.implementation_status,
				enablement_status=excluded.enablement_status,max_native_concurrency=excluded.max_native_concurrency,policy_version=excluded.policy_version,disabled_reason=excluded.disabled_reason;
			commit;
		`);
		need(docker(psql, `select runtime_bundle_sha256 from public.qorpera_active_runtime_bundle where singleton;`) === F.previousBundle, "BASELINE_BUNDLE_DIFFERS");
		for (const step of STEPS) {
			let before;
			if (MUTATIONS.includes(step)) {
				before = readback(`reconcile-${step}.sql`);
				need(classifyReconciliation(before.value, step) === "before-state-matched", "BEFORE_RECONCILIATION_FAILED");
			}
			const after = readback(`${step}.sql`, step);
			if (MUTATIONS.includes(step)) {
				const reconciled = readback(`reconcile-${step}.sql`);
				need(classifyReconciliation(reconciled.value, step) === "after-state-matched", "AFTER_RECONCILIATION_FAILED");
				docker(psql, sql[`${step}.sql`], true);
				validateReadback(readback(`reconcile-${step}.sql`).value, step);
			}
			results.push({ step, beforeSha256: before?.sha256 ?? null, afterSha256: after.sha256, ledgerEntries: after.value.ledgerVersions.length });
			console.log(`PASS wrapper ${results.length}/${STEPS.length}: ${step}`);
		}
		// Recheck every source and SQL pin after the database process finishes.
		checkPacket();
		passed = true;
	} finally {
		if (started) docker(["rm", "-f", container]);
		if (created) docker(["volume", "rm", volume]);
		need(!docker(["ps", "-a", "--format", "{{.Names}}"]).split("\n").includes(container), "CONTAINER_CLEANUP_UNCONFIRMED");
		need(!docker(["volume", "ls", "--format", "{{.Name}}"]).split("\n").includes(volume), "VOLUME_CLEANUP_UNCONFIRMED");
		console.log("Confirmed disposable wrapper database and volume removed");
	}
	need(passed && results.length === STEPS.length, "WRAPPER_REHEARSAL_INCOMPLETE");
	const receipt = { schema: "qorpera.rollout-wrapper-rehearsal/v1", packetSha256: PACKET_SHA256, passed: true,
		databaseKind: "disposable-postgresql", databaseImage: IMAGE, databaseNetwork: "none", productionWrites: false, modelCalls: false,
		allMutationStepsRehearsed: true, replayRejected: true, cleanupConfirmed: true, schemaSha256: baseline.schemaSha256,
		rehearsalToolSha256: hash(readTrusted(join(ROOT, "rehearse-wrapper.mjs"))),
		baselineSha256: hash(readTrusted(join(ROOT, "rehearsal-baseline.json"))),
		baselineMigrationsReplayed: beforeMigrations.length, steps: results,
		sql: Object.fromEntries(Object.entries(packet.sql).map(([name, pin]) => [name, pin.sha256])) };
	writeExclusive(join(ROOT, "WRAPPER-REHEARSAL.json"), receipt);
	return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { need(process.argv.length === 3, "Usage: node rehearse-wrapper.mjs /absolute/pinned-production-schema.sql");
		console.log(JSON.stringify(await rehearseWrapper(process.argv[2])));
	} catch (error) { console.error(JSON.stringify({ passed: false, reason: error.message, productionWrites: false })); process.exitCode = 1; }
}
