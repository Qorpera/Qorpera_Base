-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Default staff execution authority (20260923030000, narrowed by 20260928230000):
-- a standing authority names a company account only. Hiring an agent into a
-- company with only members' logins grants nothing, and the agent is still
-- reachable, because the member who started the work pays for it. When a company
-- account that can run appears, agents without an authority receive it; a
-- configured authority is never replaced; an agent whose projected provider no
-- company account serves gets nothing.
reset role;

do $$
begin
	if has_function_privilege('anon', 'public.qorpera_ensure_default_staff_execution_authorities(uuid,uuid)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_ensure_default_staff_execution_authorities(uuid,uuid)', 'EXECUTE') then
		raise exception 'API clients can grant staff execution authority';
	end if;
end
$$;

-- A member hires agents through the ordinary client entry point.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_put_profile_staff(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-0000000000d1','Dana','Sales development',
	'Own outbound design-partner conversations.',null,null,'blue','round','flame','openai','gpt-native','active','setup',
	statement_timestamp(),null);
select public.qorpera_put_profile_staff(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-0000000000d2','Erin','Support',
	'Answer customer questions.',null,null,'green','round','owl',null,null,'active','setup',
	statement_timestamp(),null);
select public.qorpera_put_profile_staff(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-0000000000d3','Finn','Legal',
	'Review contracts.',null,null,'red','round','fox','anthropic','claude-native','active','setup',
	statement_timestamp(),null);
reset role;
select pg_temp.path_claims('service_role');

do $$
declare v_send jsonb;
begin
	-- Only the owner's login exists: nobody stands on it.
	if exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010') then
		raise exception 'an agent received a standing authority on a member login';
	end if;
	-- A freshly hired agent is reachable all the same: the member who started the
	-- chain pays (the sender is a member wake and acknowledges the member first, as in 380).
	perform pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
	v_send := public.qorpera_send_coworker_message(current_setting('qorpera_test.wake_binding')::jsonb,
		'30000000-0000-4000-8000-0000000000d1','30000000-0000-4000-8000-0000000000e1','Welcome aboard, Dana.');
	if v_send ->> 'status' not in ('queued','held') then
		raise exception 'a coworker message to a freshly hired agent was refused: %', v_send;
	end if;
	if v_send ->> 'status' = 'queued' and not exists (select 1 from public.qorpera_wake_occurrences
		where id = (v_send ->> 'occurrenceId')::uuid
			and sponsor_binding_id = (current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid) then
		raise exception 'the coworker wake is not paid by the member who started the chain';
	end if;
end
$$;

-- A company account that cannot run yet grants nothing; once its kind runs, a new
-- company account grants the agents that have no authority, matching provider only.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.company_connection',public.qorpera_register_provider_connection(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-0000000000e4',null,
	'openai','api_key','codex-cli','vault://company/openai','org-fixture','company-api-billing','qorpera-provider-consent/v1',null,
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}',
	true)::text,true);
select set_config('qorpera_test.company_sponsor',public.qorpera_create_execution_sponsor_binding(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-0000000000e5','company_api_billing',
	(current_setting('qorpera_test.company_connection')::jsonb ->> 'connection_id')::uuid,1,true)::text,true);
reset role;
do $$
begin
	if exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010') then
		raise exception 'a company account that cannot run became a standing authority';
	end if;
end
$$;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_set_provider_execution_policy('openai','api_key','codex-cli','supported','enabled',64,null,null);
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.company_sponsor',public.qorpera_create_execution_sponsor_binding(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-0000000000e6','company_api_billing',
	(current_setting('qorpera_test.company_connection')::jsonb ->> 'connection_id')::uuid,1,true)::text,true);
reset role;
do $$
declare v_company uuid := (current_setting('qorpera_test.company_sponsor')::jsonb ->> 'binding_id')::uuid;
begin
	-- The fixture's three agents and Dana (openai) and Erin (no provider) receive the company account.
	if (select count(*) from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010' and sponsor_binding_id = v_company
			and sponsor_version = 1 and logical_computer_id is null
			and configured_by_user_id = '30000000-0000-4000-8000-000000000001') <> 5 then
		raise exception 'agents did not receive the company account as their standing authority';
	end if;
	-- Finn projects a provider no company account serves: nothing is invented.
	if exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010'
			and staff_agent_id = '30000000-0000-4000-8000-0000000000d3') then
		raise exception 'an agent received authority on an account of another provider';
	end if;
end
$$;

-- The grant is idempotent and re-applied when an agent becomes active again;
-- an agent that leaves keeps nothing new; a newer company account replaces nothing.
delete from public.qorpera_staff_execution_authorities
where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-0000000000d1';
update public.qorpera_profile_staff set employment_status = 'archived', updated_at = clock_timestamp()
where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-0000000000d1';
do $$
begin
	if exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-0000000000d1') then
		raise exception 'an archived agent received authority';
	end if;
end
$$;
update public.qorpera_profile_staff set employment_status = 'active', updated_at = clock_timestamp()
where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-0000000000d1';
do $$
begin
	if not exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-0000000000d1'
			and sponsor_binding_id = (current_setting('qorpera_test.company_sponsor')::jsonb ->> 'binding_id')::uuid) then
		raise exception 'a re-activated agent did not receive the default authority';
	end if;
end
$$;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.second_sponsor',public.qorpera_create_execution_sponsor_binding(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-0000000000e7','company_api_billing',
	(current_setting('qorpera_test.company_connection')::jsonb ->> 'connection_id')::uuid,1,true)::text,true);
reset role;
do $$
declare v_second uuid := (current_setting('qorpera_test.second_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_first uuid := (current_setting('qorpera_test.company_sponsor')::jsonb ->> 'binding_id')::uuid;
begin
	if v_second = v_first then raise exception 'the second company account is not a new binding'; end if;
	if exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010' and sponsor_binding_id = v_second) then
		raise exception 'a newer company account replaced an existing authority';
	end if;
	-- A later-hired agent takes the newest company account.
	insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,appearance_color,appearance_shape,
		employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
	values ('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-0000000000d4','Gus','Ops','Keep the lights on.',
		'blue','round','active','setup','openai','gpt-native',clock_timestamp(),clock_timestamp(),'30000000-0000-4000-8000-000000000001');
	if not exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-0000000000d4'
			and sponsor_binding_id = v_second and sponsor_version = 1) then
		raise exception 'a later hire did not take the newest company account';
	end if;
end
$$;

rollback;
