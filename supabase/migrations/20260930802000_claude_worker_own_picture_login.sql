set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_claude_worker_run_facts(jsonb)') is null then
		raise exception '20260930802000 needs Claude Code workers on the home (20260930772000)'; end if;
	if position('ownCodexLogin' in pg_get_functiondef('public.qorpera_claude_worker_run_facts(jsonb)'::regprocedure)) > 0 then
		raise exception '20260930802000 is already applied'; end if;
end $$;

create or replace function public.qorpera_claude_worker_run_facts(p_binding jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_worker public.qorpera_runtime_workers%rowtype; v_paths jsonb;
	v_marker constant text := '20260930802000';
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Claude Code worker facts are the runtime''s' using errcode = '42501'; end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_worker := public.qorpera_run_worker(v_run.id);
	if v_worker.id is null or v_worker.harness is distinct from 'claude-code' then
		raise exception 'The run is no Claude Code worker''s' using errcode = '42501'; end if;
	select coalesce(jsonb_agg(changed.path order by changed.at desc, changed.path), '[]'::jsonb) into v_paths
	from (select v.path, max(v.created_at) as at
		from public.qorpera_folder_path_versions v join public.qorpera_folder_commits c on c.id = v.commit_id
		where c.run_id = v_run.id and c.environment_id = v_run.environment_id
			and c.view_kind = 'test_machine'
			and v.kind = 'file' and v.op in ('write', 'move_in', 'copy')
		group by v.path order by max(v.created_at) desc, v.path limit 64) changed;
	return jsonb_build_object('schema', 'qorpera.claude-worker-run-facts/v1',
		'member', public.qorpera_claude_worker_member_name(v_run.profile_id, v_worker.requested_by_user_id),
		'outputs', v_paths,
		'earlier', case when v_worker.sequence > 1 then (select left(v.structured -> 'parse' ->> 'summary', 2000)
			from public.qorpera_folder_path_versions v
			where v.environment_id = v_run.environment_id
				and v.key_sha256 = extensions.digest(public.qorpera_folder_key(v_worker.folder_path || '/results.md'), 'sha256')
				and v.op = 'write'
			order by v.created_at desc, v.version desc limit 1) end,
		'ownCodexLogin', v_run.sponsored_by_user_id is not null and v_worker.requested_by_user_id is not null
			and v_run.sponsored_by_user_id = v_worker.requested_by_user_id);
end $$;
revoke all on function public.qorpera_claude_worker_run_facts(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_claude_worker_run_facts(jsonb) to service_role;
