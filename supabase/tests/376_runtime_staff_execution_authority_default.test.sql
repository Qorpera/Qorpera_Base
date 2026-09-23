-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Default staff execution authority (20260923030000): an agent hired into a
-- company that has an autonomous native-subscription sponsor is reachable by
-- coworker wakes at once; a configured authority is never replaced; an agent
-- whose projected provider no sponsor serves gets nothing.
reset role;

do $$
begin
	if has_function_privilege('anon', 'public.qorpera_ensure_default_staff_execution_authorities(uuid,uuid)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_ensure_default_staff_execution_authorities(uuid,uuid)', 'EXECUTE') then
		raise exception 'API clients can grant staff execution authority';
	end if;
end
$$;

-- The fixture's three agents hold the configured authority on the wake sponsor.
do $$
declare v_count integer;
begin
	select count(*) into v_count from public.qorpera_staff_execution_authorities
	where profile_id = '30000000-0000-4000-8000-000000000010'
		and sponsor_binding_id = (current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid
		and sponsor_version = 1;
	if v_count <> 3 then raise exception 'fixture authorities differ: %', v_count; end if;
end
$$;

-- A member hires an agent through the ordinary client entry point.
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
declare v_authority public.qorpera_staff_execution_authorities%rowtype; v_send jsonb;
begin
	-- Dana projects the sponsor's provider; Erin projects none. Both are reachable.
	for v_authority in
		select * from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010'
			and staff_agent_id in ('30000000-0000-4000-8000-0000000000d1','30000000-0000-4000-8000-0000000000d2')
	loop
		if v_authority.sponsor_binding_id <> (current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid
			or v_authority.sponsor_version <> 1 or v_authority.logical_computer_id is not null
			or v_authority.configured_by_user_id <> '30000000-0000-4000-8000-000000000001' then
			raise exception 'default authority differs for %', v_authority.staff_agent_id;
		end if;
	end loop;
	if (select count(*) from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010'
			and staff_agent_id in ('30000000-0000-4000-8000-0000000000d1','30000000-0000-4000-8000-0000000000d2')) <> 2 then
		raise exception 'hired agents did not receive the default authority';
	end if;
	-- Finn projects a provider no sponsor serves: no authority is invented.
	if exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010'
			and staff_agent_id = '30000000-0000-4000-8000-0000000000d3') then
		raise exception 'an agent received authority on a sponsor of another provider';
	end if;
	-- The coworker wake path binds to the default authority (the sender is a
	-- member wake and acknowledges the member first, as in 380).
	perform pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
	v_send := public.qorpera_send_coworker_message(current_setting('qorpera_test.wake_binding')::jsonb,
		'30000000-0000-4000-8000-0000000000d1','30000000-0000-4000-8000-0000000000e1','Welcome aboard, Dana.');
	if v_send ->> 'status' not in ('queued','held') then
		raise exception 'a coworker message to a freshly hired agent was refused: %', v_send;
	end if;
end
$$;

-- The grant is idempotent and re-applied when an agent becomes active again;
-- an agent that leaves keeps nothing new.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_configure_staff_execution_authority(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-0000000000d2',
	(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1,null);
reset role;
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
			and sponsor_binding_id = (current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid) then
		raise exception 'a re-activated agent did not receive the default authority';
	end if;
end
$$;

-- A newer autonomous sponsor grants only agents that still have none; a
-- configured or defaulted authority is never replaced.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.second_sponsor',public.qorpera_create_member_execution_sponsor(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-0000000000e2',
	(current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id')::uuid,2,true)::text,true);
reset role;
do $$
declare v_second uuid := (current_setting('qorpera_test.second_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_first uuid := (current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid;
begin
	if v_second = v_first then raise exception 'the second sponsor is not a new binding'; end if;
	if exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010' and sponsor_binding_id = v_second) then
		raise exception 'a newer sponsor replaced an existing authority';
	end if;
	if (select count(*) from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010' and sponsor_binding_id = v_first) <> 5 then
		raise exception 'existing authorities changed';
	end if;
	-- A later-hired agent takes the newest sponsor.
	insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,appearance_color,appearance_shape,
		employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
	values ('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-0000000000d4','Gus','Ops','Keep the lights on.',
		'blue','round','active','setup','openai',null,clock_timestamp(),clock_timestamp(),'30000000-0000-4000-8000-000000000001');
	if not exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-0000000000d4'
			and sponsor_binding_id = v_second and sponsor_version = 1) then
		raise exception 'a later hire did not take the newest sponsor';
	end if;
end
$$;

rollback;
