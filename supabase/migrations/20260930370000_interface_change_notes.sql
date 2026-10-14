-- Interfaces I10 (deploy/first-node/RUNTIME-INTERFACES.md §9 decision 2, §10 row I10; contract 2026-10-02 amendment,
-- item 7): an agent's page change shows in its conversation, with Undo.
--
-- qorpera_folder_note_interface_change, a native host call (scope binding): after save_interface's commit, the runtime
-- asks for a note of it in the run's conversation. The note is a session_info event (schema
-- qorpera.interface-change/v1) that names the commit and each path version it made, with the version before it. The web
-- draws it as one line with Undo, which a member's own commit makes (C4's member route), based on the versions the
-- agent's commit left. One note a commit: its event id comes from the commit, so a replay finds the note it made.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if to_regprocedure('public.qorpera_folder_note_interface_change(jsonb,jsonb)') is not null then
		raise exception 'I10 (20260930370000) is already applied'; end if;
end $$;

-- The note of the binding run's save_interface commit. The request is {operationKey}: the commit's operation key
-- (save_interface:<sha256 of the model's key>). Answers {schema, noted, eventId}: noted false, with no event, when the
-- run has no conversation (a silent routine's), or no commit of this run under that key saved anything (a proposal, a
-- refusal, or the key's commit is another run's). The run check refuses a run whose conversation closed; the check under
-- the session lock catches one that closes in between. Locks as a run that writes its conversation does (C1C §5.6): the
-- run check, its reads (rank 10), then the session FOR UPDATE (rank 11). A malformed request refuses (22023).
create function public.qorpera_folder_note_interface_change(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	c_schema constant text := 'qorpera.interface-change-note/v1';
	v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_commit public.qorpera_folder_commits%rowtype;
	v_event uuid; v_changes jsonb;
begin
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	if jsonb_typeof(p_request) is distinct from 'object'
		or exists (select 1 from jsonb_object_keys(p_request) as key(name) where key.name <> 'operationKey')
		or jsonb_typeof(p_request -> 'operationKey') is distinct from 'string'
		or p_request ->> 'operationKey' !~ '^save_interface:[0-9a-f]{64}$' then
		raise exception 'interface change note request is malformed' using errcode = '22023'; end if;
	select c.* into v_commit from public.qorpera_folder_operation_keys k
	join public.qorpera_folder_commits c on c.id = k.commit_id
	where k.environment_id = v_run.environment_id and k.operation_key = p_request ->> 'operationKey'
		and c.environment_id = v_run.environment_id and c.run_id = v_run.id and c.actor_kind = 'staff_agent'
		and c.actor_id = v_run.staff_agent_id;
	if v_run.session_id is null or v_commit.id is null or v_commit.seq is null then
		return jsonb_build_object('schema', c_schema, 'noted', false, 'eventId', null); end if;
	v_event := md5('qorpera.interface-change:' || v_commit.id::text)::uuid;
	-- Rank 10: the run's released reads still hold; then its conversation (rank 11).
	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
	perform public.qorpera_folder_lock_sessions(v_run.environment_id, jsonb_build_array(jsonb_build_object(
		'rank', 11, 'tbl', 'qorpera_shared_sessions', 'key', v_run.session_id::text, 'mode', 'update', 'required', false)));
	if exists (select 1 from public.qorpera_session_events where event_id = v_event) then
		return jsonb_build_object('schema', c_schema, 'noted', true, 'eventId', v_event); end if;
	if not exists (select 1 from public.qorpera_shared_sessions where id = v_run.session_id
		and environment_id = v_run.environment_id and status = 'open') then
		return jsonb_build_object('schema', c_schema, 'noted', false, 'eventId', null); end if;
	select jsonb_agg(jsonb_build_object('unit', v.unit_no, 'op', v.op, 'kind', v.kind, 'path', v.path,
			'version', v.version, 'priorVersion', v.prior_version) order by v.unit_no, v.path collate "C")
	into v_changes
	from public.qorpera_folder_path_versions v where v.commit_id = v_commit.id;
	perform public.qorpera_append_kernel_session_event(v_run.session_id, v_event, 'session_info',
		v_run.requested_by_user_id, jsonb_build_object('schema', 'qorpera.interface-change/v1', 'commitId', v_commit.id,
			'seq', v_commit.seq, 'runId', v_run.id, 'staffAgentId', v_run.staff_agent_id,
			'changes', coalesce(v_changes, '[]'::jsonb)));
	return jsonb_build_object('schema', c_schema, 'noted', true, 'eventId', v_event);
end $$;
revoke all on function public.qorpera_folder_note_interface_change(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_folder_note_interface_change(jsonb, jsonb) to service_role;
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_folder_note_interface_change', 'binding');
