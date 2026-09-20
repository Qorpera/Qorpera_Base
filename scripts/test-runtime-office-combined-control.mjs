import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

// Disposable SQL authority for the whole Linux guest proof. Only the RPC
// transport, physical enrollment and pre-existing browser sign-in are fixtures.
// No native identity, receipt, resource lease or Company File function is mocked.
export async function createOfficeCombinedControl(root, { rebuild = false } = {}) {
	const container = `qorpera-office-combined-db-${randomUUID()}`;
	const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "office", "-v", "ON_ERROR_STOP=1"];
	const sql = value => `'${String(value).replaceAll("'", "''")}'`;
	const valueSql = value => value === null ? "null" : typeof value === "object" ? `${sql(JSON.stringify(value))}::jsonb` : sql(value);
	function docker(args, input) {
		const result = spawnSync("docker", args, {input, encoding:"utf8", timeout:60000, maxBuffer:8*1024*1024});
		assert.equal(result.status, 0, result.stderr || String(result.error));
		return result.stdout.trim();
	}
	const query = input => docker(psql, input);
	const close = () => { spawnSync("docker", ["rm", "-f", container], {stdio:"ignore", timeout:10000}); };
	const service = `set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
	const allowed = new Set([
		"qorpera_describe_native_tool_authority", "qorpera_native_office_descriptor", "qorpera_native_office_screen",
		"qorpera_native_office_operation", "qorpera_native_office_browser_grant", "qorpera_check_runtime_office_shared_surface",
		"qorpera_runtime_office_screen_appearance", "qorpera_office_screen_browser_grant",
		"qorpera_begin_native_tool_operation", "qorpera_complete_native_tool_operation", "qorpera_native_office_file_export",
		"qorpera_native_office_file_import", "qorpera_native_company_file_write_source", "qorpera_native_company_file_write",
		"qorpera_verify_company_path_file", "qorpera_verify_company_path_tree", "qorpera_authorize_native_company_object_upload",
		"qorpera_confirm_native_company_object_upload", "qorpera_authorize_native_company_object_download",
	]);
	const calls = [];
	const acquired = [];
	try {
		docker(["run", "-d", "--rm", "--pull", "never", "--name", container, "--network", "none",
			"-e", "POSTGRES_PASSWORD=disposable-combined-only", "-e", "POSTGRES_DB=office", POSTGRES_IMAGE]);
		let ready = false;
		for (let i=0; i<60 && !ready; i++) {
			ready = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "office"], {timeout:2000}).status === 0;
			if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
		}
		assert(ready);
		query(await readFile(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
		const migrations = sortMigrationNames(await readdir(join(root, "supabase/migrations")));
		for (const name of migrations) query(await readFile(join(root, "supabase/migrations", name), "utf8"));
		const wake = (await readFile(join(root, "supabase/tests/300_runtime_wake_bus.test.sql"), "utf8")).split("-- END WAKE FIXTURE");
		const office = (await readFile(join(root, "supabase/tests/fixtures/runtime-office-registry-cases.sql"), "utf8")).split("set local role service_role;\nselect set_config('qorpera_test.office_lease'");
		assert.equal(wake.length, 2); assert.equal(office.length, 2);
		const setup = JSON.parse(query(`${wake[0]}\n${office[0]}
${await readFile(join(root, "supabase/tests/fixtures/runtime-office-company-file-source.sql"), "utf8")}
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_runtime_office_access((current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,'30000000-0000-4000-8000-000000000031',1,true);
select public.qorpera_register_runtime_browser_profile(current_setting('qorpera_test.office_scope')::jsonb,'34000000-0000-4000-8000-000000000071');
reset role;
-- Existing signed-in profile preparation is a fixture, consent is an actual owner RPC.
update public.qorpera_runtime_browser_profiles set prepared=true,verified_version=version where id='34000000-0000-4000-8000-000000000071';
set local role authenticated;
select public.qorpera_set_runtime_browser_grant(current_setting('qorpera_test.office_scope')::jsonb,'34000000-0000-4000-8000-000000000071','30000000-0000-4000-8000-000000000030',1,0,true);
select set_config('qorpera_test.second_turn',public.qorpera_request_session_turn_v2('30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),extensions.gen_random_uuid(),
 '{"schema":"qorpera.session-prompt/v1","text":"Combine the independently produced office reports.","images":[]}','member_connection',(current_setting('qorpera_test.wake_sponsor')::jsonb->>'binding_id')::uuid,1,null,
 (current_setting('qorpera_test.wake_identity')::jsonb->>'compute_identity_id')::uuid,null,'managed_sandbox','agent_turn','agent_turn','automatic',null,'{}')::text,true);
reset role;
select pg_temp.path_claims('service_role'); set local role service_role;
select public.qorpera_materialize_session_turn_requests(32);
select set_config('qorpera_test.second_binding',pg_temp.wake_start((current_setting('qorpera_test.second_turn')::jsonb->>'turn_request_id')::uuid)::text,true);
select pg_temp.wake_public_send(current_setting('qorpera_test.second_binding')::jsonb,'progress');
select jsonb_build_object('bindings',jsonb_build_array(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.second_binding')::jsonb),
 'scope',current_setting('qorpera_test.office_scope')::jsonb,'companyFile',current_setting('qorpera_test.company_import_source')::jsonb);
commit;`).split("\n").at(-1));
		console.log(`Combined proof: ${migrations.length} migrations, two actual native runs admitted`);
		const renew = () => {
			for (const binding of setup.bindings) {
				const args = `${sql(binding.runnerId)},repeat('2',64),${sql(binding.jobId)},repeat('3',64)`;
				query(`${service} select public.qorpera_renew_runner_job(${args});
					select public.qorpera_renew_native_provider_connection_lease(${sql(binding.leaseId)},${args},120);`);
			}
		};
		if (rebuild) {
			renew();
			const reservation = JSON.parse(query(`${service} select public.qorpera_reserve_runtime_machine(${sql(randomUUID())},'lxd',repeat('c',64),null,null,${sql(setup.scope.companyComputerId)},1);`));
			assert.equal(reservation.state,"reserved");
		}
		const canonical = () => query(`select jsonb_build_object(
			'company',(select to_jsonb(f) from public.qorpera_company_files f where environment_id=${sql(setup.scope.environmentId)}),
			'snapshot',(select to_jsonb(s) from public.qorpera_company_snapshots s join public.qorpera_company_files f on f.head_snapshot_id=s.id where f.environment_id=${sql(setup.scope.environmentId)}),
			'entries',(select jsonb_agg(to_jsonb(e) order by path) from public.qorpera_company_path_entries e where environment_id=${sql(setup.scope.environmentId)}),
			'allocations',(select jsonb_agg(to_jsonb(a) order by id) from public.qorpera_runtime_machine_allocations a));`);
		let retained;
		return {
			setup, close,
			rpc(method, args) {
				assert(allowed.has(method), `Unexpected combined RPC: ${method}`);
				const parameters = Object.entries(args).map(([key,value]) => {
					assert(/^p_[a-z][a-z0-9_]*$/.test(key)); return `${key}=>${valueSql(value)}`;
				});
				calls.push({method, action:args.p_action});
				const result = JSON.parse(query(`${service} select to_jsonb(public.${method}(${parameters.join(",")}));`) || "null");
				if (method === "qorpera_native_office_screen" && args.p_action === "acquire" && result.state === "admitted")
					acquired.push({binding:args.p_binding,lease:result.lease});
				return result;
			},
			async prepareRebuild() {
				assert(rebuild); assert(acquired.length >= 4);
				renew();
				retained = canonical();
				const entries = JSON.parse(retained).entries;
				assert(entries.some(e=>e.path === "source.bin")); assert(entries.some(e=>e.path === "offline-report.bin"));
				assert.equal(JSON.parse(retained).allocations.length,1);
				// PostgreSQL is physically restarted too. No table is restored,
				// no stale lease is revived, and no capacity is released.
				docker(["restart",container]);
				let ready = false;
				for (let i=0;i<40 && !ready;i++) {
					ready = spawnSync("docker",["exec",container,"pg_isready","-h","127.0.0.1","-U","postgres","-d","office"],{timeout:2000}).status === 0;
					if (!ready) await new Promise(resolve=>setTimeout(resolve,250));
				}
				assert(ready); assert.equal(canonical(),retained);
				for (const old of acquired) {
					const denied = spawnSync("docker",psql,{input:`${service} select public.qorpera_native_office_screen(${valueSql(old.binding)},${valueSql(setup.scope)},'check',${valueSql(old.lease)});`,encoding:"utf8",timeout:10000});
					assert.notEqual(denied.status,0,"Released screen authority survived rebuild boundary");
					assert.match(denied.stderr,/Office screen lease/);
				}
				return {...setup,rebuild:true,retainedCanonical:JSON.parse(retained)};
			},
			verify() {
				if (retained) { assert.equal(canonical(),retained); console.log(JSON.stringify({schema:"qorpera.office-rebuild-sql-proof/v1",databaseRestart:true,canonicalStateUnchanged:true,chargedAllocations:1,allocationBytesUnchanged:true,staleScreenLeasesRefused:true})); }
				assert.equal(query("select count(*) from public.qorpera_runtime_office_resources where state='active';"), "0");
				assert.equal(query("select count(*) from public.qorpera_runtime_office_screens where lease_id is not null;"), "0");
				const result = JSON.parse(query(`select jsonb_build_object('staffRuns',(select count(distinct r.staff_agent_id) from public.qorpera_execution_runs r join public.qorpera_run_operation_receipts o on o.run_id=r.id where o.status='completed'),
 'completedReceipts',(select count(*) from public.qorpera_run_operation_receipts where status='completed'),
 'publishedFiles',(select count(*) from public.qorpera_company_path_entries where path='offline-report.bin'))`));
				assert.equal(result.staffRuns, 2); assert.equal(result.publishedFiles, 1);
				console.log(JSON.stringify({schema:"qorpera.office-combined-sql-proof/v1", ...result, rpcCalls:calls.length, activeResources:0, screenLeases:0}));
			},
		};
	} catch (error) { close(); throw error; }
}
