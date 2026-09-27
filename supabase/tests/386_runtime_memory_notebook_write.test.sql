-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Runtime Step 6 (bundle v86): an agent writes its own memory notebook, and the
-- folders on the way to it; nothing else under agents/, never another agent's.
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

-- Production agents read the Company File but write only where a rule lets them
-- (the fixture grants this agent root write; take it back to read-only).
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
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress','memory-ack');

do $$
declare
	v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
	v_root text := 'agents/30000000-0000-4000-8000-000000000030/memory';
	v_write jsonb;
begin
	perform pg_temp.mkdir_as(v_binding,'memory-dir-1','agents');
	perform pg_temp.mkdir_as(v_binding,'memory-dir-2','agents/30000000-0000-4000-8000-000000000030');
	perform pg_temp.mkdir_as(v_binding,'memory-dir-3',v_root);
	perform pg_temp.mkdir_as(v_binding,'memory-dir-4',v_root || '/log');
	v_write := pg_temp.write_as(v_binding,'memory-write-1',v_root || '/profile.md','- (2026-09-24) I own the ledger.' || chr(10));
	perform pg_temp.wake_assert(v_write ->> 'state' = 'applied','An agent writes its own notebook profile as live state');
	v_write := pg_temp.write_as(v_binding,'memory-write-2',v_root || '/log/2026-09.md','- (2026-09-24) Harbour-85.' || chr(10));
	perform pg_temp.wake_assert(v_write ->> 'state' = 'applied','An agent appends to its own monthly log');
end $$;

-- Nothing else under the agent's folder, never another agent's notebook, and no
-- general write came with it.
select pg_temp.wake_error($q$select pg_temp.write_as(current_setting('qorpera_test.wake_binding')::jsonb,'memory-bad-0',
	'notes.md','x')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.write_as(current_setting('qorpera_test.wake_binding')::jsonb,'memory-bad-1',
	'agents/30000000-0000-4000-8000-000000000030/charter.md','x')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.mkdir_as(current_setting('qorpera_test.wake_binding')::jsonb,'memory-bad-2',
	'agents/30000000-0000-4000-8000-000000000099')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.write_as(current_setting('qorpera_test.wake_binding')::jsonb,'memory-bad-3',
	'agents/30000000-0000-4000-8000-000000000030/memoryx.md','x')$q$,'42501');
