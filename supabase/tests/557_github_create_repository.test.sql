-- 20260930556000: agents create GitHub repositories (v194 item 7, 3 November 2026). The catalog row, the backfill
-- that issues it to agents of an existing shared GitHub connection, and a new share and a new hire that carry it.
-- Synthetic identities only; no broker credential or provider, and no envelope beyond random bytes.
begin;

create function pg_temp.repo_assert(p_value boolean, p_message text)
returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception 'GitHub repository creation: %', p_message; end if; end
$$;

-- 1. The catalog row: GitHub create_repository v1, closed, private unless the call says false.
select pg_temp.repo_assert((select count(*) = 1 from public.qorpera_cloud_connector_operations
	where connector_id = 'github' and operation_id = 'create_repository' and version = 1 and status = 'active'
		and tool_name = 'github_create_repository' and destination_origin = 'https://api.github.com'
		and credential_name = 'access_token' and adapter_sha256 ~ '^[0-9a-f]{64}$'), 'the catalog row is missing');
select pg_temp.repo_assert((select input_schema -> 'required' = '["name"]'::jsonb
		and input_schema -> 'additionalProperties' = 'false'::jsonb
		and (select array_agg(key order by key) from jsonb_object_keys(input_schema -> 'properties') as key)
			= array['auto_init', 'description', 'name', 'owner', 'private']
		and input_schema #>> '{properties,private,type}' = 'boolean'
		and input_schema #>> '{properties,auto_init,type}' = 'boolean'
		and input_schema #>> '{properties,name,pattern}' = '^[A-Za-z0-9_.-]{1,100}$'
		and input_schema #>> '{properties,owner,pattern}' = '^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$'
	from public.qorpera_cloud_connector_operations where connector_id = 'github' and operation_id = 'create_repository'),
	'the schema differs');
select pg_temp.repo_assert((select count(*) = 8 from public.qorpera_cloud_connector_operations
	where connector_id = 'github' and status = 'active'), 'GitHub does not have eight operations');
-- Every agent's connector tools still fit the native list (at most 32 grants), and no tool takes a field named input:
-- a call may send its fields on their own or inside input (cloud-secret-tools.ts).
select pg_temp.repo_assert((select count(*) <= 32 from public.qorpera_cloud_connector_operations
	where connector_id in ('github', 'gmail', 'google_drive') and status = 'active'), 'the catalog outgrew the list');
select pg_temp.repo_assert(not exists (select 1 from public.qorpera_cloud_connector_operations
	where input_schema -> 'properties' ? 'input'), 'a connector operation takes a field named input');

-- 2. No API role may run the backfill.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_function_privilege(v_role,
			'public.qorpera_backfill_connector_operation_grants(text,text,text,bigint)', 'EXECUTE') then
			raise exception 'The connector grant backfill is exposed to %', v_role;
		end if;
	end loop;
end
$$;

-- 3. A company whose GitHub connection was shared before the new operation existed.
insert into auth.users(id, email) values
	('55700000-0000-4000-8000-000000000001', 'repo-owner@example.test'),
	('55700000-0000-4000-8000-000000000002', 'repo-admin@example.test'),
	('55700000-0000-4000-8000-000000000003', 'repo-member@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('55700000-0000-4000-8000-000000000010', 'Repository fixture', '55700000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('55700000-0000-4000-8000-000000000010', '55700000-0000-4000-8000-000000000001', 'repo-owner@example.test', 'Owner', 'owner'),
	('55700000-0000-4000-8000-000000000010', '55700000-0000-4000-8000-000000000002', 'repo-admin@example.test', 'Admin', 'admin'),
	('55700000-0000-4000-8000-000000000010', '55700000-0000-4000-8000-000000000003', 'repo-member@example.test', 'Member', 'contributor');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id) values
	('55700000-0000-4000-8000-000000000020', '55700000-0000-4000-8000-000000000010', 'Environment', 1,
		'55700000-0000-4000-8000-000000000001'),
	('55700000-0000-4000-8000-000000000021', '55700000-0000-4000-8000-000000000010', 'Second environment', 1,
		'55700000-0000-4000-8000-000000000001');
-- Agents 30 to 38, made before any connection (so the hire trigger issues nothing): 37 is archived.
insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter,
	appearance_color, appearance_shape, employment_status, lifecycle_state, model_provider, model_id, created_at, updated_at,
	updated_by_user_id)
select '55700000-0000-4000-8000-000000000010', ('55700000-0000-4000-8000-0000000000' || suffix)::uuid, 'Agent ' || suffix,
	'Engineering', 'Build the shop.', 'blue', 'round', case when suffix = '37' then 'archived' else 'active' end, 'active',
	'openai', 'gpt-native', clock_timestamp(), clock_timestamp(), '55700000-0000-4000-8000-000000000001'
from (values ('30'), ('31'), ('32'), ('33'), ('34'), ('35'), ('36'), ('37'), ('38')) as ids(suffix);
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('55700000-0000-4000-8000-000000000040', '55700000-0000-4000-8000-000000000010',
	'https://secrets.qorpera.test', 'company-kek-1', repeat('c', 64));
-- 50: the company's shared GitHub connection. 51: a member's own. 52: a company secret never shared.
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
	connector_id, secret_name, purpose, current_version, created_by_user_id, available_to_all_agents) values
	('55700000-0000-4000-8000-000000000050', '55700000-0000-4000-8000-000000000010', '55700000-0000-4000-8000-000000000020',
		'55700000-0000-4000-8000-000000000040', 'company', null, 'github', 'primary', 'Company GitHub', 3,
		'55700000-0000-4000-8000-000000000001', true),
	('55700000-0000-4000-8000-000000000051', '55700000-0000-4000-8000-000000000010', '55700000-0000-4000-8000-000000000020',
		'55700000-0000-4000-8000-000000000040', 'member', '55700000-0000-4000-8000-000000000001', 'github', 'mine',
		'My GitHub', 1, '55700000-0000-4000-8000-000000000001', false),
	('55700000-0000-4000-8000-000000000052', '55700000-0000-4000-8000-000000000010', '55700000-0000-4000-8000-000000000020',
		'55700000-0000-4000-8000-000000000040', 'company', null, 'github', 'second', 'Second GitHub', 1,
		'55700000-0000-4000-8000-000000000001', false);
-- Each agent's create_issue grant, as the share issued it before the new operation:
--   30 live, by the owner, no expiry          -> gets create_repository, no expiry
--   31 live, by the admin, expiring tomorrow  -> gets it, issued by the admin, same expiry
--   32 revoked                                -> nothing
--   33 expired yesterday                      -> nothing
--   34 issued by a member who is no owner or admin -> nothing
--   35 live, but its create_repository grant was revoked before -> stays revoked, nothing new
--   36 on the member's own connection        -> nothing
--   37 an archived agent                      -> nothing
--   38 on the company secret that is not shared -> nothing
insert into public.qorpera_cloud_secret_operation_grants(profile_id, environment_id, secret_id, staff_agent_id,
	connector_id, operation_id, operation_version, tool_name, issued_by_user_id, status, revoked_at, created_at, expires_at)
select '55700000-0000-4000-8000-000000000010', '55700000-0000-4000-8000-000000000020',
	case suffix when '36' then '55700000-0000-4000-8000-000000000051' when '38' then '55700000-0000-4000-8000-000000000052'
		else '55700000-0000-4000-8000-000000000050' end::uuid,
	('55700000-0000-4000-8000-0000000000' || suffix)::uuid, 'github', 'create_issue', 1, 'github_create_issue',
	case suffix when '31' then '55700000-0000-4000-8000-000000000002' when '34' then '55700000-0000-4000-8000-000000000003'
		else '55700000-0000-4000-8000-000000000001' end::uuid,
	case when suffix = '32' then 'revoked' else 'active' end,
	case when suffix = '32' then statement_timestamp() end,
	statement_timestamp() - interval '2 days',
	case suffix when '31' then statement_timestamp() + interval '1 day' when '33' then statement_timestamp() - interval '1 day' end
from (values ('30'), ('31'), ('32'), ('33'), ('34'), ('35'), ('36'), ('37'), ('38')) as ids(suffix);
insert into public.qorpera_cloud_secret_operation_grants(profile_id, environment_id, secret_id, staff_agent_id,
	connector_id, operation_id, operation_version, tool_name, issued_by_user_id, status, revoked_at, revoked_by_user_id)
values ('55700000-0000-4000-8000-000000000010', '55700000-0000-4000-8000-000000000020',
	'55700000-0000-4000-8000-000000000050', '55700000-0000-4000-8000-000000000035', 'github', 'create_repository', 1,
	'github_create_repository', '55700000-0000-4000-8000-000000000001', 'revoked', statement_timestamp(),
	'55700000-0000-4000-8000-000000000001');

select pg_temp.repo_assert(public.qorpera_backfill_connector_operation_grants('github', 'create_issue',
	'create_repository', 1) = 2, 'the backfill did not issue exactly two grants');
select pg_temp.repo_assert((select array_agg(added.staff_agent_id::text || ':' || added.issued_by_user_id::text || ':'
		|| coalesce((added.expires_at = source.expires_at)::text, 'none') order by added.staff_agent_id)
	from public.qorpera_cloud_secret_operation_grants as added
	join public.qorpera_cloud_secret_operation_grants as source on source.staff_agent_id = added.staff_agent_id
		and source.secret_id = added.secret_id and source.tool_name = 'github_create_issue'
	where added.profile_id = '55700000-0000-4000-8000-000000000010' and added.tool_name = 'github_create_repository'
		and added.status = 'active' and added.secret_id = '55700000-0000-4000-8000-000000000050'
		and added.operation_version = 1)
	= array['55700000-0000-4000-8000-000000000030:55700000-0000-4000-8000-000000000001:none',
		'55700000-0000-4000-8000-000000000031:55700000-0000-4000-8000-000000000002:true'],
	'the backfill issued to other agents, under another issuer or with another expiry');
select pg_temp.repo_assert((select count(*) = 1 and bool_and(status = 'revoked')
	from public.qorpera_cloud_secret_operation_grants
	where staff_agent_id = '55700000-0000-4000-8000-000000000035' and tool_name = 'github_create_repository'),
	'the backfill restored a revoked grant');
select pg_temp.repo_assert((select count(*) = 2 and bool_and(audit.secret_version = 3 and audit.actor_user_id = grant_row.issued_by_user_id)
	from public.qorpera_cloud_secret_audit_events as audit
	join public.qorpera_cloud_secret_operation_grants as grant_row on grant_row.id = audit.grant_id
	where audit.profile_id = '55700000-0000-4000-8000-000000000010' and audit.event_type = 'grant_issued'
		and audit.connector_id = 'github' and audit.operation_id = 'create_repository'),
	'the backfill audit differs');
-- Running it again issues nothing and writes no audit.
select pg_temp.repo_assert(public.qorpera_backfill_connector_operation_grants('github', 'create_issue',
	'create_repository', 1) = 0, 'the backfill issued grants twice');
select pg_temp.repo_assert((select count(*) = 2 from public.qorpera_cloud_secret_audit_events
	where profile_id = '55700000-0000-4000-8000-000000000010' and operation_id = 'create_repository'),
	'the second backfill wrote audit rows');
-- An operation that is not in the catalog issues nothing.
select pg_temp.repo_assert(public.qorpera_backfill_connector_operation_grants('github', 'create_issue',
	'delete_repository', 1) = 0, 'the backfill issued an operation the catalog does not have');

-- 4. A connection shared now carries every GitHub operation, the new one included, to every active agent; a later
-- hire receives it from each shared connection.
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
	connector_id, secret_name, purpose, current_version, created_by_user_id)
values ('55700000-0000-4000-8000-000000000053', '55700000-0000-4000-8000-000000000010',
	'55700000-0000-4000-8000-000000000021', '55700000-0000-4000-8000-000000000040', 'company', null, 'github', 'primary',
	'Company GitHub', 1, '55700000-0000-4000-8000-000000000001');
select pg_temp.repo_assert(public.qorpera_share_company_connection('55700000-0000-4000-8000-000000000053',
	'55700000-0000-4000-8000-000000000001') = 64, 'a new share did not issue eight operations to eight active agents');
select pg_temp.repo_assert((select count(*) = 8 from public.qorpera_cloud_secret_operation_grants
	where secret_id = '55700000-0000-4000-8000-000000000053' and status = 'active'
		and tool_name = 'github_create_repository'), 'a new share left out github_create_repository');
insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter,
	appearance_color, appearance_shape, employment_status, lifecycle_state, model_provider, model_id, created_at, updated_at,
	updated_by_user_id)
values ('55700000-0000-4000-8000-000000000010', '55700000-0000-4000-8000-000000000039', 'Newcomer', 'Engineering',
	'Build the shop.', 'green', 'round', 'active', 'setup', 'openai', 'gpt-native', clock_timestamp(), clock_timestamp(),
	'55700000-0000-4000-8000-000000000001');
select pg_temp.repo_assert((select count(*) = 2 and count(distinct secret_id) = 2
	from public.qorpera_cloud_secret_operation_grants
	where staff_agent_id = '55700000-0000-4000-8000-000000000039' and status = 'active'
		and tool_name = 'github_create_repository'), 'a new hire did not receive github_create_repository');

rollback;
