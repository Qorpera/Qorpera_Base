-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A company account as a folder-v2 company's agents' default standing authority (20260923030000, narrowed by
-- 20260928230000): only the service role grants it; a company account that cannot run yet grants nothing; once its kind
-- runs, a new company account grants the agents that have no authority; the grant is re-applied when an archived agent
-- becomes active again through its agent.md; a newer company account replaces nothing, and a later hire takes the newest
-- (ported from snapshot-v1 in the legacy sweep).
create function pg_temp.sd_agent(p_handle text, p_id uuid, p_name text, p_status text) returns jsonb language sql as $$
	select pg_temp.base_write('agents/' || p_handle || '/agent.md', 'agent',
		format(E'---\nid: %s\nname: %s\nrole: Research\nkind: agent\nstatus: %s\n---\nRead and change the company folder.\n',
			p_id, p_name, p_status),
		jsonb_build_object('kind', 'agent', 'id', p_id, 'name', p_name, 'role', 'Research', 'agentKind', 'agent', 'status', p_status,
			'colour', null, 'figure', null, 'model', null, 'effort', null, 'instructions', 'Read and change the company folder.'),
		pg_temp.base_version('agents/' || p_handle || '/agent.md'))
$$;

do $$
begin
	if has_function_privilege('anon', 'public.qorpera_ensure_default_staff_execution_authorities(uuid,uuid)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_ensure_default_staff_execution_authorities(uuid,uuid)', 'EXECUTE') then
		raise exception 'API clients can grant staff execution authority';
	end if;
end
$$;

-- The owner hires Dana through her agent.md.
select pg_temp.base_commit(pg_temp.base_owner(), 'sd-hire-dana', jsonb_build_array(
	pg_temp.base_hire('dana', '37600000-0000-4000-8000-0000000000d1', 'Dana'))) \g /dev/null

-- A company account that cannot run yet grants nothing; once its kind runs, a new company account grants the agents
-- that have no authority.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.sd_company_connection',public.qorpera_register_provider_connection(
	'92400000-0000-4000-8000-000000000010','37600000-0000-4000-8000-0000000000e4',null,
	'openai','api_key','codex-cli','vault://company/openai','org-fixture','company-api-billing','qorpera-provider-consent/v1',null,
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}',
	true)::text,true) \g /dev/null
select set_config('qorpera_test.sd_company_sponsor',public.qorpera_create_execution_sponsor_binding(
	'92400000-0000-4000-8000-000000000010','37600000-0000-4000-8000-0000000000e5','company_api_billing',
	(current_setting('qorpera_test.sd_company_connection')::jsonb ->> 'connection_id')::uuid,1,true)::text,true) \g /dev/null
reset role;
do $$
begin
	if exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '92400000-0000-4000-8000-000000000010') then
		raise exception 'a company account that cannot run became a standing authority';
	end if;
end
$$;
select pg_temp.base_claims('service_role');
set local role service_role;
select public.qorpera_set_provider_execution_policy('openai','api_key','codex-cli','supported','enabled',64,null,null) \g /dev/null
reset role;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.sd_company_sponsor',public.qorpera_create_execution_sponsor_binding(
	'92400000-0000-4000-8000-000000000010','37600000-0000-4000-8000-0000000000e6','company_api_billing',
	(current_setting('qorpera_test.sd_company_connection')::jsonb ->> 'connection_id')::uuid,1,true)::text,true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
do $$
declare v_company uuid := (current_setting('qorpera_test.sd_company_sponsor')::jsonb ->> 'binding_id')::uuid;
begin
	-- The Co-Founder, Alice, Bob, Carol and Dana receive the company account.
	if (select count(*) from public.qorpera_staff_execution_authorities
		where profile_id = '92400000-0000-4000-8000-000000000010' and sponsor_binding_id = v_company
			and sponsor_version = 1 and logical_computer_id is null
			and configured_by_user_id = '92400000-0000-4000-8000-000000000001') <> 5 then
		raise exception 'agents did not receive the company account as their standing authority';
	end if;
end
$$;

-- The grant is idempotent and re-applied when an agent becomes active again; an agent that leaves keeps nothing new;
-- a newer company account replaces nothing.
delete from public.qorpera_staff_execution_authorities
where profile_id = '92400000-0000-4000-8000-000000000010' and staff_agent_id = '37600000-0000-4000-8000-0000000000d1';
select pg_temp.base_commit(pg_temp.base_owner(), 'sd-archive-dana', jsonb_build_array(
	pg_temp.sd_agent('dana', '37600000-0000-4000-8000-0000000000d1', 'Dana', 'archived'))) \g /dev/null
do $$
begin
	perform pg_temp.base_assert((select employment_status from public.qorpera_profile_staff
		where profile_id = '92400000-0000-4000-8000-000000000010' and staff_agent_id = '37600000-0000-4000-8000-0000000000d1')
		= 'archived', 'Dana is archived');
	if exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '92400000-0000-4000-8000-000000000010' and staff_agent_id = '37600000-0000-4000-8000-0000000000d1') then
		raise exception 'an archived agent received authority';
	end if;
end
$$;
select pg_temp.base_commit(pg_temp.base_owner(), 'sd-return-dana', jsonb_build_array(
	pg_temp.sd_agent('dana', '37600000-0000-4000-8000-0000000000d1', 'Dana', 'active'))) \g /dev/null
do $$
begin
	if not exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '92400000-0000-4000-8000-000000000010' and staff_agent_id = '37600000-0000-4000-8000-0000000000d1'
			and sponsor_binding_id = (current_setting('qorpera_test.sd_company_sponsor')::jsonb ->> 'binding_id')::uuid) then
		raise exception 'a re-activated agent did not receive the default authority';
	end if;
end
$$;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.sd_second_sponsor',public.qorpera_create_execution_sponsor_binding(
	'92400000-0000-4000-8000-000000000010','37600000-0000-4000-8000-0000000000e7','company_api_billing',
	(current_setting('qorpera_test.sd_company_connection')::jsonb ->> 'connection_id')::uuid,1,true)::text,true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
do $$
declare v_second uuid := (current_setting('qorpera_test.sd_second_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_first uuid := (current_setting('qorpera_test.sd_company_sponsor')::jsonb ->> 'binding_id')::uuid;
begin
	if v_second = v_first then raise exception 'the second company account is not a new binding'; end if;
	if exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '92400000-0000-4000-8000-000000000010' and sponsor_binding_id = v_second) then
		raise exception 'a newer company account replaced an existing authority';
	end if;
end
$$;
-- A later-hired agent takes the newest company account.
select pg_temp.base_commit(pg_temp.base_owner(), 'sd-hire-gus', jsonb_build_array(
	pg_temp.base_hire('gus', '37600000-0000-4000-8000-0000000000d4', 'Gus'))) \g /dev/null
do $$
begin
	if not exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '92400000-0000-4000-8000-000000000010' and staff_agent_id = '37600000-0000-4000-8000-0000000000d4'
			and sponsor_binding_id = (current_setting('qorpera_test.sd_second_sponsor')::jsonb ->> 'binding_id')::uuid
			and sponsor_version = 1) then
		raise exception 'a later hire did not take the newest company account';
	end if;
end
$$;

rollback;
