-- @fixture 832_runtime_member_stops_worker_run.test.sql until "-- 1. The owner may stop the leased worker run; a viewer reads it but may not."
-- C5 (20260930508000) with the beta off, for a run another run makes and a run a group chat post makes. Test 924's
-- company never chose Shared context. The worker 832's base dispatched (through the folder worker commit, started by the
-- folder worker drain) and Carol, named in a group chat post (626's group chat), each get a run the materializer records
-- with Agent notebooks, and neither run has a run log place or a view.
select pg_temp.base_claims('service_role');

-- A started run in Agent notebooks with nothing of the tree: no run log place and no view.
create function pg_temp.nb_none(p_binding jsonb, p_what text) returns void language plpgsql as $$
declare v_run uuid := (p_binding ->> 'runId')::uuid;
begin
	perform pg_temp.base_assert((select memory_mode from public.qorpera_execution_runs where id = v_run) = 'notebooks',
		p_what || ' is recorded with notebooks');
	perform pg_temp.base_assert(public.qorpera_memory_run_log_place('92400000-0000-4000-8000-000000000020', v_run) = '{"off":true}'::jsonb,
		p_what || ' has no run log place');
	perform pg_temp.base_assert(public.qorpera_memory_view(p_binding) is null and public.qorpera_memory_view_of(v_run) is null,
		p_what || ' has no view');
end
$$;

-- 1. The worker's run, which the drain started and a runner leased.
select pg_temp.nb_none(pg_temp.ws_child(), 'The worker''s run') \g /dev/null

-- 2. A group chat of the owner, the member and the agents Bob and Carol (626's). The owner's post names Carol, so it
--    wakes only her, and the next pass makes her run.
select pg_temp.base_commit(pg_temp.base_owner(), 'mn-group-launch', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/groups'),
	jsonb_build_object('op', 'new_folder', 'path', 'QorperaOS/agents/groups/launch',
		'contents', jsonb_build_array(jsonb_build_object('path', 'group.md', 'kind', 'file', 'file', pg_temp.base_stage(g.text))),
		'structured', jsonb_build_array(jsonb_build_object('path', 'QorperaOS/agents/groups/launch/group.md', 'kind', 'group', 'text', g.text,
			'parse', jsonb_build_object('kind', 'group', 'id', '62600000-0000-4000-8000-000000000628', 'name', 'Launch', 'subtitle', null,
				'agents', '["92400000-0000-4000-8000-000000000031","92400000-0000-4000-8000-000000000032"]'::jsonb,
				'people', '["92400000-0000-4000-8000-000000000001","92400000-0000-4000-8000-000000000002"]'::jsonb, 'purpose', 'Plan the launch.'),
			'parserVersion', 1)))))
from (select E'---\nid: 62600000-0000-4000-8000-000000000628\nname: Launch\nagents:\n  - 92400000-0000-4000-8000-000000000031\n'
	|| E'  - 92400000-0000-4000-8000-000000000032\npeople:\n  - 92400000-0000-4000-8000-000000000001\n'
	|| E'  - 92400000-0000-4000-8000-000000000002\n---\nPlan the launch.\n' as text) g \g /dev/null

-- The owner posts on their own sponsor, as a browser does; returns who woke.
create function pg_temp.mn_post(p_text text, p_client uuid default extensions.gen_random_uuid()) returns uuid[] language plpgsql as $$
declare v_result jsonb; v_woken uuid[];
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_result := public.qorpera_post_company_room_message('62600000-0000-4000-8000-000000000628', p_client,
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', p_text),
		(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid, 1);
	reset role;
	perform pg_temp.base_claims('service_role');
	select coalesce(array_agg(staff_agent_id order by staff_agent_id), '{}') into v_woken from public.qorpera_wake_occurrences
	where id in (select jsonb_array_elements_text(v_result -> 'occurrenceIds')::uuid);
	perform set_config('qorpera_test.mn_input', v_result ->> 'inputId', true);
	return v_woken;
end $$;

do $$
declare v_pass jsonb; v_run uuid;
begin
	perform pg_temp.base_assert(pg_temp.mn_post('@Carol what is the launch date?') = array['92400000-0000-4000-8000-000000000032']::uuid[],
		'The post wakes Carol');
	v_pass := pg_temp.base_materialize(16);
	select run_id into strict v_run from public.qorpera_wake_occurrences where source_id = current_setting('qorpera_test.mn_input')::uuid;
	perform pg_temp.base_assert(v_pass -> 'run_ids' ? v_run::text, 'Carol''s run: ' || v_pass::text);
	perform pg_temp.nb_none(pg_temp.base_start(v_run), 'Carol''s group chat run');
end
$$;

rollback;
