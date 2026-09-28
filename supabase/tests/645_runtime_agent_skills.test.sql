-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Agent skills (contract 15.2): an agent writes its own skill library and the
-- folders on the way to it, as it writes its notebook; nothing else under
-- agents/, never another agent's library. The company library (skills/) needs
-- an ordinary write grant. The runtime observes the three skill tools.
select pg_temp.path_claims('service_role');
create function pg_temp.write_as(p_binding jsonb,p_key text,p_path text,p_text text) returns jsonb language plpgsql as $$
declare v_saved text := current_setting('qorpera_test.wake_binding'); v_result jsonb;
begin
	perform set_config('qorpera_test.wake_binding',p_binding::text,true);
	v_result := pg_temp.path_commit(pg_temp.path_plan(p_key,p_path,pg_temp.path_stage_file(p_path,p_text)));
	perform set_config('qorpera_test.wake_binding',v_saved,true);
	return v_result;
end $$;
create function pg_temp.mkdir_as(p_binding jsonb,p_key text,p_path text) returns jsonb language plpgsql as $$
declare v_saved text := current_setting('qorpera_test.wake_binding'); v_result jsonb;
begin
	perform set_config('qorpera_test.wake_binding',p_binding::text,true);
	v_result := pg_temp.path_commit(pg_temp.path_plan(p_key,p_path,jsonb_build_object('path',p_path,'kind','directory')));
	perform set_config('qorpera_test.wake_binding',v_saved,true);
	return v_result;
end $$;

-- Production agents may have only read on the company root: take the fixture's root write back.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
do $$
declare v_resource public.qorpera_company_path_resources%rowtype; v_grant uuid;
begin
	select * into strict v_resource from public.qorpera_company_path_resources
	where environment_id = '30000000-0000-4000-8000-000000000020' and path = '';
	for v_grant in select id from public.qorpera_company_path_grants where resource_id = v_resource.id
		and principal_id = '30000000-0000-4000-8000-000000000030' and revoked_at is null loop
		perform public.qorpera_revoke_company_path(v_resource.id,v_resource.version,v_grant);
	end loop;
	select * into strict v_resource from public.qorpera_company_path_resources
	where environment_id = '30000000-0000-4000-8000-000000000020' and path = '';
	perform public.qorpera_grant_company_path(v_resource.id,v_resource.version,'staff_agent',
		'30000000-0000-4000-8000-000000000030',array['read']);
end
$$;
select pg_temp.path_claims('service_role');

-- A human wake owes its acknowledgement before any work.
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress','skills-ack');

do $$
declare
	v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
	v_root text := 'agents/30000000-0000-4000-8000-000000000030/skills';
	v_write jsonb;
begin
	perform pg_temp.mkdir_as(v_binding,'skills-dir-1','agents');
	perform pg_temp.mkdir_as(v_binding,'skills-dir-2','agents/30000000-0000-4000-8000-000000000030');
	perform pg_temp.mkdir_as(v_binding,'skills-dir-3',v_root);
	perform pg_temp.mkdir_as(v_binding,'skills-dir-4',v_root || '/monthly-vat-report');
	v_write := pg_temp.write_as(v_binding,'skills-write-1',v_root || '/monthly-vat-report/SKILL.md',
		'---' || chr(10) || 'name: monthly-vat-report' || chr(10) || 'description: "VAT."' || chr(10) || '---' || chr(10));
	perform pg_temp.wake_assert(v_write ->> 'state' = 'applied','An agent writes a skill into its own library as live state');
	v_write := pg_temp.write_as(v_binding,'skills-write-2',v_root || '/monthly-vat-report/template.md','A template.');
	perform pg_temp.wake_assert(v_write ->> 'state' = 'applied','A skill folder holds its supporting files');
end $$;

-- Nothing else under the agent's folder, never another agent's library, and the
-- company library needs a real write grant.
select pg_temp.wake_error($q$select pg_temp.mkdir_as(current_setting('qorpera_test.wake_binding')::jsonb,'skills-bad-0',
	'skills')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.write_as(current_setting('qorpera_test.wake_binding')::jsonb,'skills-bad-1',
	'agents/30000000-0000-4000-8000-000000000030/charter.md','x')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.mkdir_as(current_setting('qorpera_test.wake_binding')::jsonb,'skills-bad-2',
	'agents/30000000-0000-4000-8000-000000000099')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.write_as(current_setting('qorpera_test.wake_binding')::jsonb,'skills-bad-3',
	'agents/30000000-0000-4000-8000-000000000030/skillsx.md','x')$q$,'42501');

-- The memory rule still holds beside the skill rule.
do $$
declare v_write jsonb;
begin
	perform pg_temp.mkdir_as(current_setting('qorpera_test.wake_binding')::jsonb,'skills-memory-dir',
		'agents/30000000-0000-4000-8000-000000000030/memory');
	v_write := pg_temp.write_as(current_setting('qorpera_test.wake_binding')::jsonb,'skills-memory-write',
		'agents/30000000-0000-4000-8000-000000000030/memory/profile.md','- (2026-09-27) I keep skills.' || chr(10));
	perform pg_temp.wake_assert(v_write ->> 'state' = 'applied','The notebook stays writable beside the skill library');
end $$;

-- The observation vocabulary names each skill tool.
do $$ begin
	perform pg_temp.wake_assert(position('''read_skill'',''search_skills'',''update_skill''' in
		pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure)) > 0,
		'The runtime observes the skill tools under their own names');
end $$;
