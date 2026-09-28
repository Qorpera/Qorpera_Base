-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Agent skills (contract 15.2): skill files have no path rule of their own. With the
-- default agent grant an agent writes the company library (skills/) and its own
-- library in its agent folder; with read only, it writes neither. The runtime observes
-- the three skill tools.
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

-- A human wake owes its acknowledgement before any work.
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress','skills-ack');

-- The fixture's agent holds the default read and write grant on the company root.
do $$
declare
	v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
	v_own text := 'agents/30000000-0000-4000-8000-000000000030/skills';
	v_write jsonb;
begin
	perform pg_temp.mkdir_as(v_binding,'skills-dir-1','skills');
	perform pg_temp.mkdir_as(v_binding,'skills-dir-2','skills/customer-refund');
	v_write := pg_temp.write_as(v_binding,'skills-write-1','skills/customer-refund/SKILL.md',
		'---' || chr(10) || 'name: customer-refund' || chr(10) || 'description: "Refund."' || chr(10) || '---' || chr(10));
	perform pg_temp.wake_assert(v_write ->> 'state' = 'applied','An agent writes a company skill under the default grant');
	perform pg_temp.mkdir_as(v_binding,'skills-dir-3','agents');
	perform pg_temp.mkdir_as(v_binding,'skills-dir-4','agents/30000000-0000-4000-8000-000000000030');
	perform pg_temp.mkdir_as(v_binding,'skills-dir-5',v_own);
	perform pg_temp.mkdir_as(v_binding,'skills-dir-6',v_own || '/monthly-vat-report');
	v_write := pg_temp.write_as(v_binding,'skills-write-2',v_own || '/monthly-vat-report/SKILL.md',
		'---' || chr(10) || 'name: monthly-vat-report' || chr(10) || 'description: "VAT."' || chr(10) || '---' || chr(10));
	perform pg_temp.wake_assert(v_write ->> 'state' = 'applied','An agent writes a skill into its own library under the default grant');
end $$;

-- Read only: no skill path is writable, the agent's own library included (no special rule).
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
select pg_temp.wake_error($q$select pg_temp.write_as(current_setting('qorpera_test.wake_binding')::jsonb,'skills-bad-0',
	'skills/customer-refund/SKILL.md','x')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.write_as(current_setting('qorpera_test.wake_binding')::jsonb,'skills-bad-1',
	'agents/30000000-0000-4000-8000-000000000030/skills/monthly-vat-report/SKILL.md','x')$q$,'42501');

-- The observation vocabulary names each skill tool, and no skill path rule was layered on.
do $$ begin
	perform pg_temp.wake_assert(position('''read_skill'',''search_skills'',''update_skill''' in
		pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure)) > 0,
		'The runtime observes the skill tools under their own names');
	perform pg_temp.wake_assert(to_regprocedure('public.qorpera_company_path_allowed_before_skills(jsonb,text,text)') is null,
		'Skills add no path authority layer');
end $$;
