-- @fixture 762_folder_core_bytes_concurrency.test.sql until "-- A. Step 6: a commit holds"
-- Company folder core, C1d-2a under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md §9.6–§9.8): the claim
-- skips what a reference holds and never waits, a reference that waited on the claim sees its mark, two claims never
-- take one object, the sweep never makes the claim wait, an upload that slips past the mark by its plain reads is a
-- root the finish restores, and the finish waits at most its lock budget. 762's committed fixture, removed at the end.
-- Waits are detected with pg_blocking_pids; only the budget case bounds a wait by time.

-- An object staged and left: put under an intent that is gone, unreferenced for two days (committed).
create function pg_temp.left_object(p_text text) returns text language plpgsql as $$
declare v_open jsonb; v jsonb := pg_temp.actor('run_one');
begin
	v_open := public.qorpera_folder_open_upload('63500000-0000-4000-8000-000000000020', v, pg_temp.manifest(array[p_text]));
	perform public.qorpera_folder_confirm_object('63500000-0000-4000-8000-000000000020', v, (v_open ->> 'intentId')::uuid,
		pg_temp.hash(p_text), octet_length(convert_to(p_text, 'utf8')));
	delete from public.qorpera_folder_upload_intents where id = (v_open ->> 'intentId')::uuid;
	insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
	values ('63500000-0000-4000-8000-000000000010', pg_temp.hash(p_text), clock_timestamp() - interval '2 days')
	on conflict (profile_id, sha256) do update set unreferenced_since = excluded.unreferenced_since, lease_id = null, lease_expires_at = null;
	return pg_temp.hash(p_text);
end $$;
create function pg_temp.sql_claim(p_lease uuid) returns text language sql as $$
	select format('select public.qorpera_folder_claim_object_gc(100, %L)', p_lease)
$$;
create function pg_temp.claims(p_result jsonb, p_sha text) returns boolean language sql as $$
	select coalesce(p_result -> 'objects' @> jsonb_build_array(jsonb_build_object('sha256', p_sha)), false)
$$;

-- R1. A reference that holds the object first: the claim skips it, and never waits.
select set_config('qorpera_test.gc_held', pg_temp.left_object('gc race held'), false);
do $$
declare v_x text := current_setting('qorpera_test.gc_held');
begin
	perform dblink_exec('auth_one', 'begin');
	-- The platform's open takes every stored object it names KEY SHARE.
	perform * from dblink('auth_one', format('select public.qorpera_folder_open_upload(%L, %L, %L)', '63500000-0000-4000-8000-000000000020',
		'{"kind":"platform"}', pg_temp.manifest(array['gc race held']))) as t(r jsonb);
	perform dblink_send_query('auth_two', pg_temp.sql_claim(extensions.gen_random_uuid()));
	if not pg_temp.finishes_unblocked('auth_two', 'auth_one') then raise exception 'The claim never waits on a reference'; end if;
	if pg_temp.claims(pg_temp.result('auth_two'), v_x) then raise exception 'An object a reference holds is skipped'; end if;
	perform dblink_exec('auth_one', 'rollback');
end $$;

-- R2. The mark is committed while a reference waits on the claim: the reference sees it once it has its lock.
select set_config('qorpera_test.gc_waits', pg_temp.left_object('gc race waits'), false);
-- A file sealed and then left: its manifest and chunk lost their roots with its intent.
select set_config('qorpera_test.gc_file', pg_temp.stage_v2(pg_temp.actor('run_one'), array['gc race file'])::text, false);
delete from public.qorpera_folder_upload_intents where manifest_sha256 = current_setting('qorpera_test.gc_file')::jsonb ->> 'manifestSha256';
insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
select '63500000-0000-4000-8000-000000000010', h, clock_timestamp() - interval '2 days'
from unnest(array[current_setting('qorpera_test.gc_file')::jsonb ->> 'manifestSha256', pg_temp.hash('gc race file')]) h
on conflict (profile_id, sha256) do update set unreferenced_since = excluded.unreferenced_since, lease_id = null, lease_expires_at = null;
do $$
declare v_x text := current_setting('qorpera_test.gc_waits'); v_state text;
begin
	-- An open (the platform names it as present) waits on the claim, then is refused.
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', pg_temp.sql_claim(extensions.gen_random_uuid())) as t(r jsonb);
	perform dblink_send_query('auth_two', format('select public.qorpera_folder_open_upload(%L, %L, %L)', '63500000-0000-4000-8000-000000000020',
		'{"kind":"platform"}', pg_temp.manifest(array['gc race waits'])));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The open waits on the claim'; end if;
	perform dblink_exec('auth_one', 'commit');
	v_state := pg_temp.outcome('auth_two');
	if v_state not like '40001 %' then raise exception 'The open sees the mark committed while it waited: %', v_state; end if;
end $$;
-- (Other sessions see only what is committed: the first claim's marks on the file are cleared here, on their own.)
update public.qorpera_folder_object_gc set lease_id = null, lease_expires_at = null
where profile_id = '63500000-0000-4000-8000-000000000010'
	and sha256 in (current_setting('qorpera_test.gc_file')::jsonb ->> 'manifestSha256', pg_temp.hash('gc race file'));
do $$
declare v_file jsonb := current_setting('qorpera_test.gc_file')::jsonb; r jsonb;
begin
	-- A commit's step 6 waits on a claim of the file's objects, then refuses the unit as for missing bytes.
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', pg_temp.sql_claim(extensions.gen_random_uuid())) as t(r jsonb);
	perform dblink_send_query('auth_two', pg_temp.sql_commit('{"kind":"platform"}', 'gc-race-step6', jsonb_build_array(
		jsonb_build_object('op','write','path','gc-race.md','file',v_file))));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'Step 6 waits on the claim'; end if;
	perform dblink_exec('auth_one', 'commit');
	r := pg_temp.result('auth_two');
	if r -> 'units' -> 0 ->> 'reason' is distinct from 'bytes_unverified' then
		raise exception 'Step 6 sees the mark committed while it waited: %', r; end if;
end $$;

-- R3. Two claims at once never take one object.
select set_config('qorpera_test.gc_twice', pg_temp.left_object('gc race twice'), false);
do $$
declare v_x text := current_setting('qorpera_test.gc_twice'); r jsonb;
begin
	perform dblink_exec('auth_one', 'begin');
	select t.r into r from dblink('auth_one', pg_temp.sql_claim(extensions.gen_random_uuid())) as t(r jsonb);
	if not pg_temp.claims(r, v_x) then raise exception 'The first claim takes it'; end if;
	perform dblink_send_query('auth_two', pg_temp.sql_claim(extensions.gen_random_uuid()));
	if not pg_temp.finishes_unblocked('auth_two', 'auth_one') then raise exception 'A second claim never waits'; end if;
	if pg_temp.claims(pg_temp.result('auth_two'), v_x) then raise exception 'A second claim skips it'; end if;
	perform dblink_exec('auth_one', 'commit');
	-- Committed, the live mark keeps it from a third.
	if pg_temp.claims(public.qorpera_folder_claim_object_gc(100, extensions.gen_random_uuid()), v_x) then
		raise exception 'A live mark keeps it from the next claim'; end if;
end $$;

-- R4. The sweep's upsert of a GC row never makes the claim wait.
select set_config('qorpera_test.gc_sweeping', pg_temp.left_object('gc race sweeping'), false);
do $$
declare v_x text := current_setting('qorpera_test.gc_sweeping');
begin
	perform dblink_exec('auth_one', 'begin');
	perform dblink_exec('auth_one', format($q$insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
		values ('63500000-0000-4000-8000-000000000010', %L, clock_timestamp() - interval '3 days')
		on conflict (profile_id, sha256) do update set unreferenced_since = excluded.unreferenced_since$q$, v_x));
	perform dblink_send_query('auth_two', pg_temp.sql_claim(extensions.gen_random_uuid()));
	if not pg_temp.finishes_unblocked('auth_two', 'auth_one') then raise exception 'The claim never waits on the sweep'; end if;
	if pg_temp.claims(pg_temp.result('auth_two'), v_x) then raise exception 'A GC row the sweep holds is skipped'; end if;
	perform dblink_exec('auth_one', 'rollback');
end $$;

-- R5. An upload slips past the mark by its plain reads (its open names the object as not present, so takes no lock):
-- its intent, committed, is a root, and the finish restores.
select set_config('qorpera_test.gc_slips', pg_temp.left_object('gc race slips'), false);
do $$
declare v_x text := current_setting('qorpera_test.gc_slips'); v_lease uuid := extensions.gen_random_uuid(); r jsonb; v_res text;
begin
	perform dblink_exec('auth_one', 'begin');
	select t.r into r from dblink('auth_one', pg_temp.sql_claim(v_lease)) as t(r jsonb);
	if not pg_temp.claims(r, v_x) then raise exception 'The claim takes it'; end if;
	perform dblink_send_query('auth_two', format('select public.qorpera_folder_open_upload(%L, %L, %L)', '63500000-0000-4000-8000-000000000020',
		pg_temp.actor('run_one'), pg_temp.manifest(array['gc race slips'])));
	if not pg_temp.finishes_unblocked('auth_two', 'auth_one') then raise exception 'An open of an object not present never waits'; end if;
	r := pg_temp.result('auth_two');
	if r -> 'present' <> '[]'::jsonb then raise exception 'The object is not present for that actor: %', r; end if;
	perform dblink_exec('auth_one', 'commit');
	v_res := public.qorpera_folder_gc_unlink_finish('63500000-0000-4000-8000-000000000010', v_x, v_lease);
	if v_res <> 'restore' then raise exception 'The intent is a root: restore, not %', v_res; end if;
	if exists (select 1 from public.qorpera_folder_object_gc where profile_id = '63500000-0000-4000-8000-000000000010' and sha256 = v_x) then
		raise exception 'In use again, its GC row goes'; end if;
end $$;

-- R6. The finish waits at most its lock budget for a reference that holds the object, even in a session that would wait
-- without limit; a lock timeout leaves the mark for the next run.
select set_config('qorpera_test.gc_budget', pg_temp.left_object('gc race budget'), false);
-- The claim, committed on its own.
select set_config('qorpera_test.gc_budget_lease', extensions.gen_random_uuid()::text, false);
do $$
begin
	if not pg_temp.claims(public.qorpera_folder_claim_object_gc(100, current_setting('qorpera_test.gc_budget_lease')::uuid),
		current_setting('qorpera_test.gc_budget')) then raise exception 'The claim takes it'; end if;
end $$;
do $$
declare v_x text := current_setting('qorpera_test.gc_budget'); v_lease uuid := current_setting('qorpera_test.gc_budget_lease')::uuid;
	v_until timestamptz; v_busy boolean; v_state text;
begin
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', format($q$select 1 from public.qorpera_profile_objects where profile_id = %L and sha256 = %L
		for key share$q$, '63500000-0000-4000-8000-000000000010', v_x)) as t(r integer);
	perform dblink_exec('auth_two', 'set lock_timeout = 0');
	perform dblink_send_query('auth_two', format('select public.qorpera_folder_gc_unlink_finish(%L, %L, %L)',
		'63500000-0000-4000-8000-000000000010', v_x, v_lease));
	-- A bound for the test only: without the budget the finish would wait as long as the holder.
	v_until := clock_timestamp() + interval '30 seconds';
	while dblink_is_busy('auth_two') = 1 and clock_timestamp() < v_until loop perform pg_sleep(0.05); end loop;
	v_busy := dblink_is_busy('auth_two') = 1;
	perform dblink_exec('auth_one', 'rollback');
	v_state := pg_temp.outcome('auth_two');
	perform dblink_exec('auth_two', 'reset lock_timeout');
	if v_busy or v_state not like '55P03 %' then raise exception 'The finish gives up at its lock budget: %', v_state; end if;
	if not exists (select 1 from public.qorpera_folder_object_gc where profile_id = '63500000-0000-4000-8000-000000000010'
		and sha256 = v_x and lease_id = v_lease) then
		raise exception 'The mark stays for the next run'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['auth_one','auth_two','auth_three']) name;

-- The committed fixture leaves the shared suite database, as 762's does.
set session_replication_role = replica;
-- (Foreign-key cascades do not run under replica: each table is cleared by name. The catalog and 635's Storage rows
-- stay, as after 635, so the fixture can run again.)
delete from public.qorpera_folder_object_gc where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_file_chunks where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_upload_intent_objects where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_upload_intents where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_storage_usage where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_authority_changes where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_reads where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_read_records where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_releases where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_journal where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_reviews where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_operation_keys where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_wake_occurrences where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_runs where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_runner_jobs where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_session_inputs where session_id in (select id from public.qorpera_shared_sessions where profile_id = '63500000-0000-4000-8000-000000000010');
delete from public.qorpera_shared_sessions where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_sponsor_versions where binding_id = '63500000-0000-4000-8000-0000000000a1';
delete from public.qorpera_execution_sponsor_bindings where id = '63500000-0000-4000-8000-0000000000a1';
delete from public.qorpera_provider_connections where id = '63500000-0000-4000-8000-0000000000b3';
set session_replication_role = origin;
delete from public.qorpera_profiles where id = '63500000-0000-4000-8000-000000000010';
delete from auth.users where id in ('63500000-0000-4000-8000-000000000001','63500000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '63500000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_object_gc where profile_id = '63500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '63500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intent_objects where profile_id = '63500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_file_chunks where profile_id = '63500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_storage_usage where profile_id = '63500000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
