-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-2b part 1 under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.6, §5.9):
-- concurrent receipt begins of one run leave one executing receipt; two commits carrying one receipt cannot both have
-- it; a completion naming a commit in flight waits for it. 648's committed fixture (Ada's leased human run on the
-- folder fence), with the run's acknowledgement recorded so its tool calls may work. Removed at the end.

-- The run's acknowledgement, as a progress send and its session event (the wake's work gate reads both).
set session_replication_role = replica;
insert into public.qorpera_session_events(session_id, sequence, event_id, event_type, actor_user_id, body, event_hash, created_at,
	execution_kind, execution_id, execution_claimant_id, runner_assignment_id)
values ('64800000-0000-4000-8000-0000000000f7', 1, '64800000-0000-4000-8000-0000000000fa', 'message', '64800000-0000-4000-8000-000000000002',
	'{"schema":"qorpera.runner-transcript-entry/v1"}', repeat('0', 64), statement_timestamp(), 'run', '64800000-0000-4000-8000-0000000000f1',
	'64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-0000000000f5');
insert into public.qorpera_agent_sends(event_id, run_id, session_id, assignment_id, idempotency_key, phase, text_sha256, body_sha256)
values ('64800000-0000-4000-8000-0000000000fa', '64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-0000000000f7',
	'64800000-0000-4000-8000-0000000000f5', 'ack', 'progress', repeat('1', 64), repeat('2', 64));
set session_replication_role = origin;

create function pg_temp.sql_begin(p_receipt uuid, p_key text) returns text language sql as $$
	select format('select public.qorpera_begin_native_tool_operation(%L, %L, %L, %L, %L, true)::text',
		current_setting('qorpera_test.binding'), p_receipt, p_key, repeat('a', 64), repeat('b', 64))
$$;
create function pg_temp.sql_rcommit(p_key text, p_path text, p_receipt uuid) returns text language sql as $$
	select format('select public.qorpera_folder_commit(%L, %L, %L, %L, null, %L)::text', '64800000-0000-4000-8000-000000000020',
		'{"kind":"run","runId":"64800000-0000-4000-8000-0000000000f1","jobId":"64800000-0000-4000-8000-0000000000f2","runnerId":"64800000-0000-4000-8000-0000000000f4","assignmentId":"64800000-0000-4000-8000-0000000000f5"}',
		p_key, jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', p_path)), p_receipt)
$$;
create function pg_temp.sql_complete(p_receipt uuid, p_commit uuid) returns text language sql as $$
	select format('select public.qorpera_folder_complete_run_receipt(%L, %L, %L, %L, %L)::text', current_setting('qorpera_test.binding'),
		p_receipt, repeat('a', 64), '{"ok":true}', p_commit)
$$;

-- A. Two receipt begins of one run at once: the second waits at the run mutex, then finds the first unresolved and
-- refuses. One executing receipt.
do $$
declare v_state text; r1 uuid := extensions.gen_random_uuid(); r2 uuid := extensions.gen_random_uuid();
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_begin(r1, 'race-begin-1')) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_begin(r2, 'race-begin-2'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A second begin must wait for the first'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_execution_run_budgets'::regclass then
		raise exception 'The second begin must wait at the run mutex, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state not like '55000 %run has an unresolved operation%' then raise exception 'The second begin: %', v_state; end if;
	if (select count(*) from public.qorpera_run_operation_receipts where run_id = '64800000-0000-4000-8000-0000000000f1'
		and status = 'executing') <> 1 then raise exception 'One executing receipt'; end if;
	perform set_config('qorpera_test.receipt', r1::text, false);
end $$;

-- B. Two commits carrying one receipt at once: the second waits at the receipt, then refuses (it is satisfied), and
-- saves nothing.
do $$
declare v_state text; v jsonb; r uuid := current_setting('qorpera_test.receipt')::uuid;
begin
	perform dblink_exec('fence_one', 'begin');
	select x::jsonb into v from dblink('fence_one', pg_temp.sql_rcommit('race-receipt-1', 'race-one', r)) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_rcommit('race-receipt-2', 'race-two', r));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A second commit with the receipt must wait for the first'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_run_operation_receipts'::regclass then
		raise exception 'The second commit must wait at the receipt, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state not like '22023 %Run receipt is already satisfied by another commit%' then raise exception 'The second commit: %', v_state; end if;
	if exists (select 1 from public.qorpera_folder_entries where environment_id = '64800000-0000-4000-8000-000000000020'
		and key_text = 'race-two') then raise exception 'The refused commit must save nothing'; end if;
	perform set_config('qorpera_test.commit', v ->> 'commitId', false);
end $$;

-- C. A completion that names a commit still in flight waits for it at the receipt, then completes with it. First the
-- earlier receipt completes and a new one begins, committed (a block is one transaction).
do $$
declare r uuid := extensions.gen_random_uuid();
begin
	perform public.qorpera_folder_complete_run_receipt(current_setting('qorpera_test.binding')::jsonb,
		current_setting('qorpera_test.receipt')::uuid, repeat('a', 64), '{"ok":true}', current_setting('qorpera_test.commit')::uuid);
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.binding')::jsonb, r, 'race-begin-3', repeat('a', 64),
		repeat('b', 64), true);
	perform set_config('qorpera_test.receipt', r::text, false);
end $$;
do $$
declare v_state text; r uuid := current_setting('qorpera_test.receipt')::uuid; v jsonb;
begin
	perform dblink_exec('fence_one', 'begin');
	select x::jsonb into v from dblink('fence_one', pg_temp.sql_rcommit('race-receipt-3', 'race-three', r)) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_complete(r, (v ->> 'commitId')::uuid));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A completion must wait for the commit carrying its receipt'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' then raise exception 'The completion after its commit: %', v_state; end if;
	if (select status || ':' || folder_commit_id from public.qorpera_run_operation_receipts where id = r) <> 'completed:' || (v ->> 'commitId') then
		raise exception 'The receipt names its commit'; end if;
end $$;

-- D. The sessions a commit's hook names are locked FOR UPDATE after the ranks and before the paths (rank 11). A commit
-- whose hook names a session another transaction holds waits there, holding no path yet: another commit of the same
-- path goes first. The hook is swapped (committed, so the connections see it) for one that names the sessions of the
-- connection's own setting, and put back at the end.
select set_config('qorpera_test.saved_hook', pg_get_functiondef('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure),
	false) \g /dev/null
create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
returns table(rank smallint, tbl text, key text, mode text) language sql stable set search_path = '' as $f$
	select (t ->> 'rank')::smallint, t ->> 'tbl', t ->> 'key', t ->> 'mode'
	from jsonb_array_elements(coalesce(nullif(current_setting('qorpera_test.targets', true), ''), '[]')::jsonb) t
$f$;
do $$
declare v_state text; v jsonb;
begin
	perform dblink_exec('fence_one', format('set qorpera_test.targets = %L', jsonb_build_array(jsonb_build_object('rank', 11,
		'tbl', 'qorpera_shared_sessions', 'key', '64800000-0000-4000-8000-0000000000f7', 'mode', 'update'))::text));
	-- Held KEY SHARE: only a FOR UPDATE (or FOR NO KEY UPDATE) waits for it, so the commit's lock mode shows.
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_shared_sessions where id = '64800000-0000-4000-8000-0000000000f7'
		for key share$q$) as t(x integer);
	perform dblink_send_query('fence_one', format('select public.qorpera_folder_commit(%L, %L, %L, %L)::text', '64800000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}', 'race-session-1', '[{"op":"mkdir","path":"race-session"}]'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'A commit must lock the sessions its hook names'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'The commit must wait at the session, not on %', pg_temp.queued_on('fence_one'); end if;
	-- The ranks come first: the committing member's row is already held (rank 1).
	begin
		perform * from dblink('fence_four', $q$select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
			and user_id = '64800000-0000-4000-8000-000000000001' for update nowait$q$) as t(x integer);
		raise exception 'The member row must be held before the sessions' using errcode = 'QTF04';
	exception when others then
		if sqlstate = 'QTF04' or sqlerrm not like '%could not obtain lock%' then raise; end if;
	end;
	-- It holds no path yet: another commit of the same path saves at once.
	perform dblink_send_query('fence_three', format('select public.qorpera_folder_commit(%L, %L, %L, %L)::text', '64800000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}', 'race-session-2', '[{"op":"mkdir","path":"race-session"}]'));
	if not pg_temp.finishes_unblocked('fence_three', 'fence_one') then raise exception 'The sessions come before the paths'; end if;
	select r::jsonb into v from dblink_get_result('fence_three') as t(r text);
	perform * from dblink_get_result('fence_three') as t(r text);
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The other commit: %', v; end if;
	perform dblink_exec('fence_two', 'rollback');
	select r::jsonb into v from dblink_get_result('fence_one') as t(r text);
	perform * from dblink_get_result('fence_one') as t(r text);
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'conflict' then raise exception 'The waiting commit, after the other: %', v; end if;
	perform dblink_exec('fence_one', 'reset qorpera_test.targets');
end $$;
-- E. With sessions at rank 11, this company's row comes first (rank 0) even when the hook names only the sessions: a
-- commit whose apply step writes a session (here a trigger standing in for F2's group-chat rename) meets legacy posting
-- (the company row FOR UPDATE, then the session) at the company row, holding no session. Without rank 0 it held the
-- session and then waited at the company row for its operations' foreign key: 40P01.
create function public.qorpera_test_touch_session() returns trigger language plpgsql security definer set search_path = '' as $f$
begin
	if new.kind <> 'claim' and coalesce(current_setting('qorpera_test.touch_session', true), '') <> '' then
		update public.qorpera_shared_sessions set title = title || '.' where id = current_setting('qorpera_test.touch_session')::uuid;
	end if;
	return new;
end $f$;
create trigger qorpera_test_touch_session after insert or update on public.qorpera_folder_entries
	for each row execute function public.qorpera_test_touch_session();
do $$
declare v_state text; v jsonb;
begin
	perform dblink_exec('fence_one', format('set qorpera_test.targets = %L', jsonb_build_array(jsonb_build_object('rank', 11,
		'tbl', 'qorpera_shared_sessions', 'key', '64800000-0000-4000-8000-0000000000f7', 'mode', 'update'))::text));
	perform dblink_exec('fence_one', $q$set qorpera_test.touch_session = '64800000-0000-4000-8000-0000000000f7'$q$);
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010' for update$q$)
		as t(x integer);
	perform dblink_send_query('fence_one', format('select public.qorpera_folder_commit(%L, %L, %L, %L)::text', '64800000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}', 'race-rank-zero', '[{"op":"mkdir","path":"race-rank-zero"}]'));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The commit must wait for the posting company row'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_profiles'::regclass then
		raise exception 'The commit must wait at the company row, not on %', pg_temp.queued_on('fence_one'); end if;
	perform dblink_send_query('fence_two', $q$select 1 from public.qorpera_shared_sessions where id = '64800000-0000-4000-8000-0000000000f7'
		for update$q$);
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'Posting must take the session at once'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_two', 'commit');
	select r::jsonb into v from dblink_get_result('fence_one') as t(r text);
	perform * from dblink_get_result('fence_one') as t(r text);
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The commit after posting: %', v; end if;
	perform dblink_exec('fence_one', 'reset qorpera_test.targets');
	perform dblink_exec('fence_one', 'reset qorpera_test.touch_session');
end $$;
drop trigger qorpera_test_touch_session on public.qorpera_folder_entries;
drop function public.qorpera_test_touch_session();

-- F. The receipt's place in the order: after the ranks, before the sessions (C1C §5.7). A commit carrying a receipt that
-- a completion holds waits at the receipt, already holding the agent's roster row (rank 2) and not yet the session it
-- names.
do $$
declare r uuid := extensions.gen_random_uuid();
begin
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.binding')::jsonb, r, 'race-order', repeat('a', 64),
		repeat('b', 64), true);
	perform set_config('qorpera_test.receipt', r::text, false);
end $$;
do $$
declare v_state text; v jsonb; r uuid := current_setting('qorpera_test.receipt')::uuid;
begin
	perform dblink_exec('fence_one', format('set qorpera_test.targets = %L', jsonb_build_array(jsonb_build_object('rank', 11,
		'tbl', 'qorpera_shared_sessions', 'key', '64800000-0000-4000-8000-0000000000f7', 'mode', 'update'))::text));
	perform dblink_exec('fence_two', 'begin');
	perform * from dblink('fence_two', format('select 1 from public.qorpera_run_operation_receipts where id = %L for update', r)) as t(x integer);
	perform dblink_send_query('fence_one', pg_temp.sql_rcommit('race-order-1', 'race-order', r));
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'The commit must wait for its receipt'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_run_operation_receipts'::regclass then
		raise exception 'The commit must wait at the receipt, not on %', pg_temp.queued_on('fence_one'); end if;
	begin
		perform * from dblink('fence_three', $q$select 1 from public.qorpera_profile_staff where profile_id = '64800000-0000-4000-8000-000000000010'
			and staff_agent_id = '64800000-0000-4000-8000-0000000000a1' for update nowait$q$) as t(x integer);
		raise exception 'The ranks must come before the receipt' using errcode = 'QTF04';
	exception when others then
		if sqlstate = 'QTF04' or sqlerrm not like '%could not obtain lock%' then raise; end if;
	end;
	perform * from dblink('fence_three', $q$select 1 from public.qorpera_shared_sessions where id = '64800000-0000-4000-8000-0000000000f7'
		for update nowait$q$) as t(x integer);
	perform dblink_exec('fence_two', 'rollback');
	select r2::jsonb into v from dblink_get_result('fence_one') as t(r2 text);
	perform * from dblink_get_result('fence_one') as t(r2 text);
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The commit after its receipt: %', v; end if;
	perform dblink_exec('fence_one', 'reset qorpera_test.targets');
end $$;

-- Put F2's hook back.
select current_setting('qorpera_test.saved_hook') \gexec

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 648 does): every row of both companies, their runs, jobs, sessions, rooms and login.
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_run_operation_receipts where run_id = '64800000-0000-4000-8000-0000000000f1')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '64800000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
