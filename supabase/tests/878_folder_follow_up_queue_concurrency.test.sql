-- @fixture 709_folder_state_routines_concurrency.test.sql until "-- A. The scheduler holds the routine"
-- Company folder core C2, P15, under concurrency (migration 20260930022000; deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md
-- "Plan (P15)"): a kick passes over a subject the step holds, and the step one a kick holds; a converge that read the
-- agent before a commit changed it retries under the lock and grants nothing; a commit that archives or reactivates an
-- agent waits for a post on its thread at rank 11, before the clock; the name copy passes over a company row held for
-- update and goes ahead beside the KEY SHARE every effect takes; and steps, commits flipping an agent and effects that
-- key-share its rows run side by side with no error. The fixture is 709's, committed; everything is removed at the end.
-- Waits are detected with pg_blocking_pids, never by wall-clock time.

-- A commit as its actor that leaves its marks for the step (the fixture's pg_temp.commit runs the queue at once).
create function pg_temp.save(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('70900000-0000-4000-8000-000000000020', p_actor, p_units);
	return public.qorpera_folder_commit('70900000-0000-4000-8000-000000000020', p_actor, p_key, p_units);
end $$;
create function pg_temp.agent(p_handle text, p_id uuid, p_status text, p_name text default null) returns jsonb language sql as $$
	select pg_temp.write('agents/' || p_handle || '/agent.md', 'agent', pg_temp.agent_text(p_id, coalesce(p_name, p_handle), 'agent', p_status),
		pg_temp.agent_parse(p_id, coalesce(p_name, p_handle), 'agent', p_status), pg_temp.version('agents/' || p_handle || '/agent.md'))
$$;
create function pg_temp.work(p_id uuid, p_kind text default 'agent') returns public.qorpera_folder_follow_ups language sql as $$
	select * from public.qorpera_folder_follow_ups where environment_id = '70900000-0000-4000-8000-000000000020'
		and subject_kind = p_kind and subject_id = p_id
$$;
create function pg_temp.thread(p_id uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where profile_id = '70900000-0000-4000-8000-000000000010'
		and bound_staff_agent_id = p_id
$$;
create function pg_temp.granted(p_id uuid) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_company_path_grants where principal_kind = 'staff_agent' and principal_id = p_id
		and origin = 'default_agent_read')
$$;
-- A sent statement's single text result, or its error.
create function pg_temp.result(p_conn text) returns text language plpgsql as $$
declare v text;
begin
	begin
		select r into v from dblink_get_result(p_conn) as t(r text);
	exception when others then v := 'error ' || sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return v;
end $$;
-- The step, as another connection's statement (its own transaction, as pg_cron runs it).
select set_config('qorpera_test.step', $q$select public.qorpera_folder_follow_up_step()::text$q$, false) \g /dev/null

-- Every commit below runs as its own statement, so the connections see it; the do blocks only hold, send and check.

-- A. A kick passes over a subject the step holds, and a step over one a kick holds: neither waits. A first mark's new row
-- another taker is inserting makes the kick wait 200 ms at most, then answer busy.

select pg_temp.expect(pg_temp.save(pg_temp.owner(), 'race-hire-otto', jsonb_build_array(
	pg_temp.hire('otto', '87800000-0000-4000-8000-0000000000a2', 'Otto'))), 1, 'saved') \g /dev/null
-- Taken once (its marks become its row's), so the row exists.
select (public.qorpera_folder_follow_up_take('70900000-0000-4000-8000-000000000020', 'agent', '87800000-0000-4000-8000-0000000000a2')).dirty \g /dev/null
do $$
declare a2 constant uuid := '87800000-0000-4000-8000-0000000000a2'; v jsonb; v_text text;
begin
	-- Another connection holds Otto's work row, as a step converging it would.
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', format($q$select dirty::text from public.qorpera_folder_follow_ups
		where environment_id = %L and subject_kind = 'agent' and subject_id = %L for update$q$,
		'70900000-0000-4000-8000-000000000020', a2)) as t(r text);
	v := public.qorpera_folder_follow_up_now('70900000-0000-4000-8000-000000000020', 'agent', a2);
	if v ->> 'result' is distinct from 'busy' then raise exception 'A kick on a held subject: %', v; end if;
	select r into v_text from dblink('rrace_sched', current_setting('qorpera_test.step')) as t(r text);
	if v_text::jsonb -> 'converged' is distinct from 'null'::jsonb then raise exception 'A step on a held subject: %', v_text; end if;
	perform dblink_exec('rrace_hold', 'commit');
	select r into v_text from dblink('rrace_sched', current_setting('qorpera_test.step')) as t(r text);
	if v_text::jsonb -> 'converged' ->> 'subjectId' is distinct from a2::text or v_text::jsonb -> 'converged' ->> 'result' is distinct from 'done'
		or not pg_temp.granted(a2) then
		raise exception 'The step converges it once free: %', v_text; end if;
end $$;
select pg_temp.expect(pg_temp.save(pg_temp.owner(), 'race-hire-rua', jsonb_build_array(
	pg_temp.hire('rua', '87800000-0000-4000-8000-0000000000a5', 'Rua'))), 1, 'saved') \g /dev/null
do $$
declare a5 constant uuid := '87800000-0000-4000-8000-0000000000a5'; v jsonb; v_text text;
begin
	-- Another taker inserting Rua's first row: the kick waits for that insert 200 ms at most.
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', format($q$select (public.qorpera_folder_follow_up_take(%L, 'agent', %L)).dirty::text$q$,
		'70900000-0000-4000-8000-000000000020', a5)) as t(r text);
	v := public.qorpera_folder_follow_up_now('70900000-0000-4000-8000-000000000020', 'agent', a5);
	if v ->> 'result' is distinct from 'busy' then raise exception 'A kick on a row being inserted: %', v; end if;
	-- The other taker rolls back: its marks are there again, and the step converges Rua.
	perform dblink_exec('rrace_hold', 'rollback');
	select r into v_text from dblink('rrace_sched', current_setting('qorpera_test.step')) as t(r text);
	if v_text::jsonb -> 'converged' ->> 'subjectId' is distinct from a5::text or v_text::jsonb -> 'converged' ->> 'result' is distinct from 'done'
		or not pg_temp.granted(a5) then
		raise exception 'The step converges it after the other taker: %', v_text; end if;
end $$;

-- B. A converge that read the agent active, and an archive that commits while it waits for the staff row: the converge
-- retries under the lock (no attempt counted) and grants nothing; the next step converges the archive.

select pg_temp.expect(pg_temp.save(pg_temp.owner(), 'race-hire-pia', jsonb_build_array(
	pg_temp.hire('pia', '87800000-0000-4000-8000-0000000000a3', 'Pia'))), 1, 'saved') \g /dev/null
select set_config('qorpera_test.archive_pia', pg_temp.sql_commit('70900000-0000-4000-8000-000000000020', pg_temp.owner()::text,
	'race-archive-pia', jsonb_build_array(pg_temp.agent('pia', '87800000-0000-4000-8000-0000000000a3', 'archived', 'Pia'))::text),
	false) \g /dev/null
do $$
declare a3 constant uuid := '87800000-0000-4000-8000-0000000000a3'; v_text text; w public.qorpera_folder_follow_ups;
begin
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', current_setting('qorpera_test.archive_pia') || '::text') as t(r text);
	perform dblink_send_query('rrace_sched', current_setting('qorpera_test.step'));
	if not pg_temp.waits_for('rrace_sched', 'rrace_hold') then raise exception 'The converge must wait for the archive at the staff row'; end if;
	perform dblink_exec('rrace_hold', 'commit');
	v_text := pg_temp.result('rrace_sched');
	w := pg_temp.work(a3);
	if v_text::jsonb -> 'converged' ->> 'result' is distinct from 'retry' or not w.dirty or w.attempts <> 0 or pg_temp.granted(a3)
		or exists (select 1 from public.qorpera_agent_first_runs where staff_agent_id = a3) then
		raise exception 'A converge over a changed agent retries and grants nothing: % / %', v_text, to_jsonb(w); end if;
	select r into v_text from dblink('rrace_sched', current_setting('qorpera_test.step')) as t(r text);
	if v_text::jsonb -> 'converged' ->> 'result' is distinct from 'done' or (pg_temp.work(a3)).dirty or pg_temp.granted(a3) then
		raise exception 'The next step converges the archive: %', v_text; end if;
end $$;

-- C. A reactivation and a post on the agent's thread: the commit waits for the post at the thread session (rank 11),
-- holding no clock, so another commit on the company goes ahead meanwhile.

select set_config('qorpera_test.reactivate_pia', pg_temp.sql_commit('70900000-0000-4000-8000-000000000020', pg_temp.owner()::text,
	'race-reactivate-pia', jsonb_build_array(pg_temp.agent('pia', '87800000-0000-4000-8000-0000000000a3', 'active', 'Pia'))::text),
	false) \g /dev/null
select set_config('qorpera_test.mkdir', format('select public.qorpera_folder_commit(%L, %L, %L, %L)::text',
	'70900000-0000-4000-8000-000000000020', '{"kind":"platform"}', 'race-mkdir-notes', '[{"op":"mkdir","path":"notes"}]'), false) \g /dev/null
do $$
declare a3 constant uuid := '87800000-0000-4000-8000-0000000000a3'; v_text text;
begin
	-- The post's input key-shares the session.
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', format($q$select id::text from public.qorpera_shared_sessions where id = %L for key share$q$,
		pg_temp.thread(a3))) as t(r text);
	perform dblink_send_query('rrace_save', current_setting('qorpera_test.reactivate_pia') || '::text');
	if not pg_temp.waits_for('rrace_save', 'rrace_hold') then raise exception 'The reactivation must wait at the thread session'; end if;
	-- Meanwhile the clock is free.
	perform dblink_exec('rrace_sched', $q$set lock_timeout = '5s'$q$);
	select r into v_text from dblink('rrace_sched', current_setting('qorpera_test.mkdir')) as t(r text);
	perform dblink_exec('rrace_sched', 'reset lock_timeout');
	if v_text::jsonb -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The clock was held: %', v_text; end if;
	perform dblink_exec('rrace_hold', 'commit');
	v_text := pg_temp.result('rrace_save');
	if v_text::jsonb -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' or (pg_temp.staff(a3)).employment_status is distinct from 'active' then
		raise exception 'The reactivation saves after the post: %', v_text; end if;
	select r into v_text from dblink('rrace_sched', current_setting('qorpera_test.step')) as t(r text);
	if v_text::jsonb -> 'converged' ->> 'result' is distinct from 'done' or not pg_temp.granted(a3) then
		raise exception 'The reactivation converges: %', v_text; end if;
end $$;

-- D. The name copy: a company row another transaction holds for update is passed over (a back-off, no wait, no error);
-- one held KEY SHARE, as every effect takes it, is no obstacle.

select pg_temp.expect(pg_temp.save(pg_temp.owner(), 'race-rename-0001', jsonb_build_array(pg_temp.vision('Nordlys Race Two'))), 1, 'saved') \g /dev/null
do $$
declare v_text text; w public.qorpera_folder_follow_ups;
begin
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', $q$select id::text from public.qorpera_profiles
		where id = '70900000-0000-4000-8000-000000000010' for no key update$q$) as t(r text);
	select r into v_text from dblink('rrace_sched', current_setting('qorpera_test.step')) as t(r text);
	perform dblink_exec('rrace_hold', 'rollback');
	w := pg_temp.work('70900000-0000-4000-8000-000000000010', 'company');
	if v_text::jsonb -> 'converged' ->> 'result' is distinct from 'dirty' or v_text::jsonb -> 'converged' ->> 'problem' is distinct from 'busy'
		or not w.dirty or w.attempts <> 0 or w.not_before <= clock_timestamp()
		or (select name from public.qorpera_profiles where id = '70900000-0000-4000-8000-000000000010') is distinct from 'Nordlys Routine Race' then
		raise exception 'A held company row is a back-off: % / %', v_text, to_jsonb(w); end if;
end $$;
update public.qorpera_folder_follow_ups set not_before = null where environment_id = '70900000-0000-4000-8000-000000000020'
	and subject_kind = 'company';
do $$
declare v_text text;
begin
	perform dblink_exec('rrace_hold', 'begin');
	perform * from dblink('rrace_hold', $q$select id::text from public.qorpera_profiles
		where id = '70900000-0000-4000-8000-000000000010' for key share$q$) as t(r text);
	select r into v_text from dblink('rrace_sched', current_setting('qorpera_test.step')) as t(r text);
	perform dblink_exec('rrace_hold', 'commit');
	if v_text::jsonb -> 'converged' ->> 'result' is distinct from 'done'
		or (select name from public.qorpera_profiles where id = '70900000-0000-4000-8000-000000000010') is distinct from 'Nordlys Race Two' then
		raise exception 'The name copy goes ahead beside a KEY SHARE: %', v_text; end if;
end $$;

-- E. Side by side: steps, commits flipping an agent between active and archived, and effects that key-share its staff
-- row, its thread and the company row, round after round. Nothing errs (no multixact error, no deadlock); at the end the
-- agent's state is its last commit's, converged.

select pg_temp.expect(pg_temp.save(pg_temp.owner(), 'race-hire-quinn', jsonb_build_array(
	pg_temp.hire('quinn', '87800000-0000-4000-8000-0000000000a4', 'Quinn'))), 1, 'saved') \g /dev/null
create temp table side_by_side(round integer, part text, answer text);
-- One round: the flip's commit, a step and an effect sent at once, their answers kept.
create function pg_temp.round(p_round integer) returns void language plpgsql as $fn$
declare v_save text; v_step text; v_effect text;
begin
	perform dblink_send_query('rrace_save', current_setting('qorpera_test.flip') || '::text');
	perform dblink_send_query('rrace_sched', current_setting('qorpera_test.step'));
	perform dblink_send_query('rrace_hold', format($q$do $e$ begin
		perform 1 from public.qorpera_profiles where id = '70900000-0000-4000-8000-000000000010' for key share;
		perform 1 from public.qorpera_profile_staff where profile_id = '70900000-0000-4000-8000-000000000010' and staff_agent_id = %L
			for key share;
		perform 1 from public.qorpera_shared_sessions where id = %L for key share;
		perform pg_sleep(0.01);
	end $e$$q$, '87800000-0000-4000-8000-0000000000a4', pg_temp.thread('87800000-0000-4000-8000-0000000000a4')));
	v_save := pg_temp.result('rrace_save'); v_step := pg_temp.result('rrace_sched'); v_effect := pg_temp.result('rrace_hold');
	insert into side_by_side values (p_round, 'save', v_save), (p_round, 'step', v_step), (p_round, 'effect', coalesce(v_effect, ''));
end $fn$;
-- Sixteen rounds, each its own statements: the flip staged and committed first, then sent.
select format($f$select set_config('qorpera_test.flip', pg_temp.sql_commit('70900000-0000-4000-8000-000000000020',
		pg_temp.owner()::text, 'race-flip-quinn-%s', jsonb_build_array(pg_temp.agent('quinn', '87800000-0000-4000-8000-0000000000a4',
		%L, 'Quinn'))::text), false) is not null$f$, i, case when i % 2 = 1 then 'archived' else 'active' end),
	format('select pg_temp.round(%s)', i)
from generate_series(1, 16) i \gexec
do $$
declare v_errors text;
begin
	select string_agg(part || ' ' || round || ': ' || answer, E'\n' order by round, part) into v_errors from side_by_side
	where answer like 'error%' or (part = 'save' and answer::jsonb -> 'units' -> 0 ->> 'outcome' is distinct from 'saved');
	if v_errors is not null then raise exception 'Side by side: %', v_errors; end if;
	if (select count(*) from side_by_side) <> 48 then raise exception 'Side by side ran % answers', (select count(*) from side_by_side); end if;
end $$;
-- The rest converges (each step its own statement); the agent ends active, converged, with its grant.
update public.qorpera_folder_follow_ups set not_before = null where environment_id = '70900000-0000-4000-8000-000000000020' and dirty;
select r from generate_series(1, 6) i, lateral dblink('rrace_sched', current_setting('qorpera_test.step')) as t(r text) \g /dev/null
do $$
declare a4 constant uuid := '87800000-0000-4000-8000-0000000000a4';
begin
	if (pg_temp.staff(a4)).employment_status is distinct from 'active' or (pg_temp.work(a4)).dirty or not pg_temp.granted(a4)
		or exists (select 1 from public.qorpera_folder_follow_up_marks where environment_id = '70900000-0000-4000-8000-000000000020') then
		raise exception 'Side by side, the agent ends converged: %', to_jsonb(pg_temp.work(a4)); end if;
end $$;

select dblink_disconnect(name) from unnest(array['rrace_sched','rrace_save','rrace_hold']) name;

-- The committed fixture leaves the shared suite database.
set session_replication_role = replica;
delete from public.qorpera_folder_reviews where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_wake_occurrences where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_runs where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_runner_jobs where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_cloud_routine_schedule_cursors where routine_id in (select id from public.qorpera_cloud_routines
	where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_cloud_routine_versions where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_cloud_routines where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_cloud_secret_operation_grants where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_staff_execution_authorities where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_session_execution_bindings where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_sponsor_versions where binding_id in (select id from public.qorpera_execution_sponsor_bindings
	where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_execution_sponsor_bindings where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_provider_connection_versions where connection_id in (select id from public.qorpera_provider_connections
	where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_provider_connections where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_company_index where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_authority_changes where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_journal where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_operation_keys where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_company_cofounders where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_session_turn_requests where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_agent_first_runs where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_session_inputs where session_id in (select id from public.qorpera_shared_sessions
	where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_folder_follow_up_marks where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_follow_ups where environment_id = '70900000-0000-4000-8000-000000000020';
delete from public.qorpera_company_room_members where room_id in (select id from public.qorpera_company_rooms where profile_id = '70900000-0000-4000-8000-000000000010');
delete from public.qorpera_company_rooms where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_shared_sessions where profile_id = '70900000-0000-4000-8000-000000000010';
delete from public.qorpera_profile_staff where profile_id = '70900000-0000-4000-8000-000000000010';
set session_replication_role = origin;
-- With triggers on: version-2 objects are catalog rows of the object gateway (no Storage mirror), so they go by
-- hand, with their proofs and chunk rows; any Storage object takes its mirror row with it.
delete from public.qorpera_profile_objects where profile_id = '70900000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '70900000-0000-4000-8000-000000000010/%';
delete from public.qorpera_profiles where id = '70900000-0000-4000-8000-000000000010';
delete from auth.users where id in ('70900000-0000-4000-8000-000000000001','70900000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '70900000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_cloud_routines where profile_id = '70900000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_profile_staff where profile_id = '70900000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_follow_ups where environment_id = '70900000-0000-4000-8000-000000000020')
		or exists (select 1 from storage.objects where name like '70900000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '70900000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '70900000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '70900000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
