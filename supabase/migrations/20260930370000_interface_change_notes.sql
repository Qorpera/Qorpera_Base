-- Interfaces I10 (deploy/first-node/RUNTIME-INTERFACES.md §7 and §9 decision 2, §10 row I10; contract 2026-10-02
-- amendment, item 7): an agent's change to the company's pages and tables shows in its conversation, with Undo, whatever
-- carried it.
--
-- qorpera_folder_note_interface_changes, a native host call (scope binding): the runtime asks it after a tool's commit
-- under interfaces/ or tables/ (save_interface, company_write, company_mkdir, company_delete), and once more as a run
-- with a computer ends, for what its shell and screen saved. It notes each of the binding run's commits that changed a
-- path there and has no note yet, so a call notes what an earlier one missed. A note is a session_info event (schema
-- qorpera.interface-change/v1) that names the commit and each path version it made there, with the version before it.
-- The web draws it as one line with Undo, which a member's own commit makes (C4's member route), based on the versions
-- the agent's commit left. One note a commit: its event id comes from the commit.
--
-- A table's rows (tables/<name>/rows.csv) are its data, written with table_write, not its layout: they are no part of a
-- note. A commit no run made (a machine's publish after its run ended) has no conversation to show it in.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if to_regprocedure('public.qorpera_folder_note_interface_changes(jsonb,jsonb)') is not null then
		raise exception 'I10 (20260930370000) is already applied'; end if;
end $$;

-- Notes the binding run's commits under interfaces/ and tables/ that have none, in the order they saved. The request is
-- {}. Answers {schema, noted}: the number of notes this call made; 0 when the run has no conversation (a silent
-- routine's). The run check refuses a run whose conversation closed; the check under the session lock catches one that
-- closes in between. Locks as a run that writes its conversation does (C1C §5.6): the run check, its reads (rank 10),
-- then the session FOR UPDATE (rank 11). A malformed request refuses (22023).
create function public.qorpera_folder_note_interface_changes(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	c_schema constant text := 'qorpera.interface-change-notes/v1';
	v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_commit record; v_hash text; v_event uuid;
	v_changes jsonb; v_noted integer := 0;
begin
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	if p_request is distinct from '{}'::jsonb then
		raise exception 'interface change note request is malformed' using errcode = '22023'; end if;
	if v_run.session_id is null then return jsonb_build_object('schema', c_schema, 'noted', 0); end if;
	-- Rank 10: the run's released reads still hold; then its conversation (rank 11).
	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
	perform public.qorpera_folder_lock_sessions(v_run.environment_id, jsonb_build_array(jsonb_build_object(
		'rank', 11, 'tbl', 'qorpera_shared_sessions', 'key', v_run.session_id::text, 'mode', 'update', 'required', false)));
	if not exists (select 1 from public.qorpera_shared_sessions where id = v_run.session_id
		and environment_id = v_run.environment_id and status = 'open') then
		return jsonb_build_object('schema', c_schema, 'noted', 0); end if;
	for v_commit in
		select c.id, c.seq from public.qorpera_folder_commits c
		where c.run_id = v_run.id and c.environment_id = v_run.environment_id and c.seq is not null
			and c.actor_kind = 'staff_agent' and c.actor_id = v_run.staff_agent_id
			and exists (select 1 from public.qorpera_folder_path_versions v where v.commit_id = c.id
				and public.qorpera_folder_key(v.path) ~ '^(interfaces|tables)/'
				and public.qorpera_folder_key(v.path) !~ '^tables/[^/]+/rows\.csv$')
		order by c.seq
	loop
		-- The commit's hash as a version 8 UUID (RFC 9562), the shape the web's event check takes.
		v_hash := md5('qorpera.interface-change:' || v_commit.id::text);
		v_event := (substr(v_hash, 1, 12) || '8' || substr(v_hash, 14, 3) || '8' || substr(v_hash, 18))::uuid;
		continue when exists (select 1 from public.qorpera_session_events where event_id = v_event);
		select jsonb_agg(jsonb_build_object('unit', v.unit_no, 'op', v.op, 'kind', v.kind, 'path', v.path,
				'version', v.version, 'priorVersion', v.prior_version) order by v.unit_no, v.path collate "C")
		into v_changes
		from public.qorpera_folder_path_versions v where v.commit_id = v_commit.id
			and public.qorpera_folder_key(v.path) ~ '^(interfaces|tables)/'
			and public.qorpera_folder_key(v.path) !~ '^tables/[^/]+/rows\.csv$';
		perform public.qorpera_append_kernel_session_event(v_run.session_id, v_event, 'session_info',
			v_run.requested_by_user_id, jsonb_build_object('schema', 'qorpera.interface-change/v1', 'commitId', v_commit.id,
				'seq', v_commit.seq, 'runId', v_run.id, 'staffAgentId', v_run.staff_agent_id, 'changes', v_changes));
		v_noted := v_noted + 1;
	end loop;
	return jsonb_build_object('schema', c_schema, 'noted', v_noted);
end $$;
revoke all on function public.qorpera_folder_note_interface_changes(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_folder_note_interface_changes(jsonb, jsonb) to service_role;
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_folder_note_interface_changes', 'binding');
