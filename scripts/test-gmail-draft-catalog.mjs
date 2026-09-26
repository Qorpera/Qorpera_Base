// Runs against a disposable hosted-db fixture already populated with the
// baseline migrations. Everything, including the new migration, rolls back.
// Usage: node scripts/test-gmail-draft-catalog.mjs <qorpera-... container>
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CATALOG_MIGRATION } from "./generate-cloud-connector-catalog.mjs";

const container = process.argv[2];
if (!container || !/^qorpera-[a-z0-9-]+$/.test(container)) throw new Error("A disposable qorpera-* database container is required");
const migration = readFileSync(new URL(`../${CATALOG_MIGRATION}`, import.meta.url), "utf8")
	.replace(/^begin;$/m, "").replace(/^commit;$/m, "");
const fixture = readFileSync(new URL("../supabase/tests/397_cloud_connector_catalog.test.sql", import.meta.url), "utf8");
const setup = fixture.slice(0, fixture.indexOf("-- The shipped catalog")).replace(/^begin;$/m, "");
const backfill = migration.split("-- BEGIN GMAIL DRAFT GRANT BACKFILL")[1].split("-- END GMAIL DRAFT GRANT BACKFILL")[0];

function sql(statement) {
	const result = spawnSync("docker", ["exec", "-i", container, "psql", "-X", "-q", "-U", "postgres", "-d", "qorpera_test", "-v", "ON_ERROR_STOP=1"], {
		input: statement, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

// New connections and hires receive the complete new catalog; historical rows
// retain their exact pinned schemas and adapter hashes.
sql(`begin;\n${migration}\n${fixture.replace(/^begin;$/m, "").replace(/^rollback;$/m, "")}\nrollback;`);

// Exercise the exact migration statement on old grants, including deliberate
// revocations, expired authority, archived agents and member-owned mailboxes.
sql(`begin;
${migration}
${setup}
insert into public.qorpera_profile_staff (profile_id,staff_agent_id,display_name,role,charter,
 appearance_color,appearance_shape,employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
select profile_id, ('38000000-0000-4000-8000-0000000000' || suffix)::uuid, display_name || suffix, role, charter,
 appearance_color, appearance_shape, employment_status, lifecycle_state, model_provider, model_id, created_at, updated_at, updated_by_user_id
from public.qorpera_profile_staff cross join (values ('34'),('35'),('36')) as ids(suffix)
where staff_agent_id='38000000-0000-4000-8000-000000000030';
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,
 connector_id,secret_name,purpose,current_version,created_by_user_id,available_to_all_agents)
values ('38000000-0000-4000-8000-000000000050','38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020',
 '38000000-0000-4000-8000-000000000040','company',null,'gmail','primary','Company mail',1,'38000000-0000-4000-8000-000000000001',true),
 ('38000000-0000-4000-8000-000000000051','38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020',
 '38000000-0000-4000-8000-000000000040','member','38000000-0000-4000-8000-000000000001','gmail','personal','Personal mail',1,'38000000-0000-4000-8000-000000000001',false);
insert into public.qorpera_cloud_secret_operation_grants(profile_id,environment_id,secret_id,staff_agent_id,
 connector_id,operation_id,operation_version,tool_name,issued_by_user_id,status,revoked_at,created_at,expires_at)
select '38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020',
 case when suffix='36' then '38000000-0000-4000-8000-000000000051' else '38000000-0000-4000-8000-000000000050' end::uuid,
 ('38000000-0000-4000-8000-0000000000' || suffix)::uuid,'gmail','send_message',1,'gmail_send_message',
 case when suffix='35' then '38000000-0000-4000-8000-000000000002' else '38000000-0000-4000-8000-000000000001' end::uuid,
 case when suffix='31' then 'revoked' else 'active' end,
 case when suffix='31' then statement_timestamp() else null end,
 statement_timestamp()-interval '2 days',
 case when suffix='34' then statement_timestamp()-interval '1 day' else statement_timestamp()+interval '1 day' end
from (values ('30'),('31'),('32'),('34'),('35'),('36')) as ids(suffix);
-- A deliberately revoked new operation stays revoked; an existing tool on a
-- different connection stays there and cannot be silently adopted.
insert into public.qorpera_cloud_secret_operation_grants(profile_id,environment_id,secret_id,staff_agent_id,
 connector_id,operation_id,operation_version,tool_name,issued_by_user_id,status,revoked_at)
values ('38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020','38000000-0000-4000-8000-000000000050',
 '38000000-0000-4000-8000-000000000030','gmail','create_draft',1,'gmail_create_draft','38000000-0000-4000-8000-000000000001','revoked',statement_timestamp()),
 ('38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020','38000000-0000-4000-8000-000000000051',
 '38000000-0000-4000-8000-000000000030','gmail','get_profile',1,'gmail_get_profile','38000000-0000-4000-8000-000000000001','active',null);
${backfill}
select pg_temp.connector_assert((select count(*)=3 from public.qorpera_cloud_secret_operation_grants
 where status='active' and operation_id in ('update_draft','delete_draft','send_draft')),'Backfill broadened ineligible grants');
select pg_temp.connector_assert((select count(*)=3 and bool_and(added.expires_at=source.expires_at)
 from public.qorpera_cloud_secret_operation_grants added join public.qorpera_cloud_secret_operation_grants source
 on source.staff_agent_id=added.staff_agent_id and source.secret_id=added.secret_id and source.operation_id='send_message'
 where added.staff_agent_id='38000000-0000-4000-8000-000000000030'
 and added.operation_id in ('update_draft','delete_draft','send_draft')),'Backfill changed grant expiry');
select pg_temp.connector_assert((select count(*)=1 and bool_and(status='revoked') from public.qorpera_cloud_secret_operation_grants
 where operation_id='create_draft'),'Backfill restored a revoked operation');
select pg_temp.connector_assert((select count(*)=3 from public.qorpera_cloud_secret_audit_events
 where event_type='grant_issued' and operation_id in ('update_draft','delete_draft','send_draft')),'Backfill audit is incomplete');
${backfill}
select pg_temp.connector_assert((select count(*)=3 from public.qorpera_cloud_secret_audit_events
 where event_type='grant_issued' and operation_id in ('update_draft','delete_draft','send_draft')),'Backfill replay duplicated grants or audit');
rollback;`);

// A same-version catalog change must fail rather than silently clobber an
// operation hash the deployed runtime already trusts.
let refused = false;
try {
	sql(`begin; update public.qorpera_cloud_connector_operations set description='Unexpected catalog drift' where connector_id='gmail' and operation_id='send_message';\n${migration}\nrollback;`);
} catch (error) {
	if (!String(error).includes("Existing connector operation changed without a new version")) throw error;
	refused = true;
}
if (!refused) throw new Error("Catalog migration accepted a same-version mutation");
console.log("Gmail catalog, grants, replay and immutable-version regressions passed");
