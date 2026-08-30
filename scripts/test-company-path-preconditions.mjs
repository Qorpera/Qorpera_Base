import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

// Synthetic disposable PostgreSQL only; no deployment credentials or model API.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-path-preconditions-${randomBytes(6).toString("hex")}`;
const correction = "20260828019950_company_path_preconditions.sql";
const targets = [
	"public.qorpera_company_path_plan(jsonb,jsonb,boolean,boolean)",
	"public.qorpera_authorize_member_company_path_object(uuid,text,uuid,text)",
	"public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text)",
	"public.qorpera_confirm_company_path_read(uuid,jsonb,uuid,integer,text)",
	"public.qorpera_decide_member_identity_recovery(uuid,uuid,uuid,text,text,uuid,text)",
	"public.qorpera_list_company_paths(uuid,text,text,uuid,integer,jsonb)",
	"public.qorpera_read_company_run_context(jsonb,text,uuid,text,integer,integer)",
	"public.qorpera_review_company_path_proposal(uuid,text,text)",
	"public.qorpera_set_company_path_resource(uuid,text,text,text,text,uuid)",
	"public.qorpera_tombstone_profile_staff(uuid,uuid,bigint,uuid,uuid,uuid)",
	"public.qorpera_lock_profile_gc_fence(uuid)",
];
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "qorpera_test", "-v", "ON_ERROR_STOP=1"];

function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
	if (result.error || result.status !== 0) throw new Error(`Disposable precondition test failed: ${result.error ?? result.stderr}`);
	return result.stdout.trim();
}

function metadata() {
	return JSON.parse(docker(psql, `select jsonb_agg(jsonb_build_object(
		'identity',proc.oid::regprocedure::text,'oid',proc.oid,'owner',proc.proowner,
		'acl',proc.proacl,'definer',proc.prosecdef,'config',proc.proconfig,
		'arguments',pg_get_function_arguments(proc.oid),'result',pg_get_function_result(proc.oid),
		'body',proc.prosrc) order by proc.oid)
		from pg_proc proc where proc.oid in (${targets.map((target) => `${literal(target)}::regprocedure`).join(",")});`));
}

let started = false;
try {
	docker(["run", "-d", "--rm", "--name", container, "--label", "qorpera.test=path-preconditions",
		"-e", "POSTGRES_PASSWORD=qorpera-test-only", "-e", "POSTGRES_DB=qorpera_test",
		"--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=1g", POSTGRES_IMAGE]);
	started = true;
	let ready = 0;
	for (let attempt = 0; attempt < 60 && ready < 2; attempt++) {
		const probe = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "qorpera_test"], { timeout: 2000 });
		ready = probe.status === 0 ? ready + 1 : 0;
		if (ready < 2) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.equal(ready, 2);
	docker(psql, readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	let before;
	for (const migration of migrations) {
		if (migration === correction) {
			// A retained definer may have a different owner from the migration.
			// Broad fixture grants belong only to this non-login test owner.
			docker(psql, `create role path_precondition_owner nologin bypassrls;
				grant usage on schema public,auth,extensions to path_precondition_owner;
				grant all on all tables in schema public to path_precondition_owner;
				grant usage on all sequences in schema public to path_precondition_owner;
				grant execute on all functions in schema public,auth,extensions to path_precondition_owner;
				${targets.map((target) => `alter function ${target} owner to path_precondition_owner;`).join("\n")}`);
			before = metadata();
		}
		docker(psql, readFileSync(join(root, "supabase/migrations", migration), "utf8"));
	}
	assert.equal(before?.length, 11, "The corrections must replace exactly eleven existing functions");
	assert.equal(before.reduce((count, value) => count + (value.body.match(/'40001'/g)?.length ?? 0), 0), 12);
	const expected = before.map((value) => ({ ...value, body: value.body.replaceAll("'40001'",
		value.identity === "qorpera_lock_profile_gc_fence(uuid)" ? "'42501'" : "'PT412'") }));
	assert.deepEqual(metadata(), expected, "Only the twelve permanent-precondition/denial error codes may change");
	docker(psql, readFileSync(join(root, "supabase/migrations", correction), "utf8"));
	assert.deepEqual(metadata(), expected, "Replaying the correction preserves owner, identity, ACL and body");
	console.log("PASS: exact precondition-only change; split owner, function identity and privileges preserved");
	for (const name of ["290_company_file_path_gateway.test.sql", "295_member_company_file_commands.test.sql",
		"299_member_identity_recovery_review.test.sql", "305_cloud_secret_custody.test.sql", "306_governed_company_computer_privileges.test.sql",
		"307_cloud_secret_member_authority.test.sql", "310_company_organization_kernel.test.sql", "315_runtime_step0_staff_lifecycle.test.sql"]) {
		docker(psql, readFileSync(join(root, "supabase/tests", name), "utf8"));
		console.log(`PASS: ${name}`);
	}
	console.log(`Passed stale-version, tombstone, native/human authority and receipt regressions after ${migrations.length} migrations`);
} finally {
	if (started) {
		docker(["rm", "-f", container]);
		console.log(`Removed disposable precondition database ${container}`);
	}
}
