-- @fixture 635_folder_core_authority_concurrency.test.sql until "-- A. A narrowing that commits while a commit is deciding"
-- Company folder core, C1d-1a under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md): commit step 6 holds
-- every object it references, staging and downloads never wait on the company, its fence, company_files or the job,
-- and two uploads of one hash store it once. 635's committed fixture, removed at the end. Waits are detected with
-- pg_blocking_pids, never by wall-clock time.

create function pg_temp.manifest(p_chunks text[]) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/plain","executable":false,"chunks":[%s]}',
		encode(extensions.digest(convert_to(array_to_string(p_chunks, ''), 'utf8'), 'sha256'), 'hex'),
		octet_length(convert_to(array_to_string(p_chunks, ''), 'utf8')),
		coalesce((select string_agg(format('{"sha256":"%s","bytes":%s}', encode(extensions.digest(convert_to(c, 'utf8'), 'sha256'), 'hex'),
			octet_length(convert_to(c, 'utf8'))), ',' order by o) from unnest(p_chunks) with ordinality u(c, o)), ''))
$$;
create function pg_temp.hash(p_text text) returns text language sql immutable as $$
	select encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex')
$$;
create function pg_temp.sql_confirm(p_actor jsonb, p_intent uuid, p_text text) returns text language sql as $$
	select format('select public.qorpera_folder_confirm_object(%L, %L, %L, %L, %s)', '63500000-0000-4000-8000-000000000020',
		p_actor::text, p_intent, pg_temp.hash(p_text), octet_length(convert_to(p_text, 'utf8')))
$$;
-- Stages and seals a file of the given chunks as the actor; committed. Returns the file reference.
create function pg_temp.stage_v2(p_actor jsonb, p_chunks text[]) returns jsonb language plpgsql as $$
declare v_manifest text := pg_temp.manifest(p_chunks); v_open jsonb; v_chunk text;
begin
	v_open := public.qorpera_folder_open_upload('63500000-0000-4000-8000-000000000020', p_actor, v_manifest);
	foreach v_chunk in array p_chunks || v_manifest loop
		perform public.qorpera_folder_confirm_object('63500000-0000-4000-8000-000000000020', p_actor, (v_open ->> 'intentId')::uuid,
			pg_temp.hash(v_chunk), octet_length(convert_to(v_chunk, 'utf8')));
	end loop;
	return public.qorpera_folder_seal_upload('63500000-0000-4000-8000-000000000020', p_actor, (v_open ->> 'intentId')::uuid) -> 'file';
end $$;

-- Staged by the run that commits them (it possesses them, C1D §3).
select set_config('qorpera_test.bytes_file', pg_temp.stage_v2(pg_temp.actor('run_one'), array['race chunk one ', 'race chunk two'])::text, false);
select set_config('qorpera_test.folder_file', pg_temp.stage_v2(pg_temp.actor('run_one'), array['new folder chunk'])::text, false);

-- A. Step 6: a commit holds the manifest and every chunk of each file it writes, puts in a new folder or copies KEY
-- SHARE until it ends, so a lock that would remove one (C1d-2's GC mark) waits for it.
do $$
declare
	v jsonb := pg_temp.actor('run_one'); v_file jsonb := current_setting('qorpera_test.bytes_file')::jsonb;
	v_folder jsonb := current_setting('qorpera_test.folder_file')::jsonb; v_sha text;
begin
	foreach v_sha in array array[v_file ->> 'manifestSha256', pg_temp.hash('race chunk one '), pg_temp.hash('race chunk two'),
		pg_temp.hash('alpha'), v_folder ->> 'manifestSha256', pg_temp.hash('new folder chunk')] loop
		perform dblink_exec('auth_one', 'begin');
		perform * from dblink('auth_one', pg_temp.sql_commit(v, 'bytes-hold-1', jsonb_build_array(
			jsonb_build_object('op','write','path','shared/bytes.txt','file',v_file),
			jsonb_build_object('op','copy','from','shared/a.txt','to','shared/a-copy.txt'),
			jsonb_build_object('op','new_folder','path','shared/nf','contents',jsonb_build_array(
				jsonb_build_object('path','f.txt','kind','file','file',v_folder)))))) as t(r jsonb);
		perform dblink_send_query('auth_two', format('select 1 from public.qorpera_profile_objects where profile_id = %L and sha256 = %L for update',
			'63500000-0000-4000-8000-000000000010', v_sha));
		if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'Step 6 holds object %', v_sha; end if;
		perform dblink_exec('auth_one', 'rollback');
		if pg_temp.outcome('auth_two') <> 'ok' then raise exception 'The waiter goes on once the commit ends'; end if;
	end loop;
end $$;

-- (Committed first: the other connections must see them, and a DO block holds what it locked until it ends.)
select pg_temp.commit(pg_temp.actor('run_one'), 'bytes-publish-1', jsonb_build_array(jsonb_build_object('op','write',
	'path','shared/pub.txt','file',current_setting('qorpera_test.bytes_file')::jsonb)));
select set_config('qorpera_test.open_b', public.qorpera_folder_open_upload('63500000-0000-4000-8000-000000000020',
	pg_temp.actor('run_one'), pg_temp.manifest(array['unblocked 2']))::text, false);
-- For C: content no earlier run stored (the catalog outlives this test, as after 635).
select set_config('qorpera_test.twice', 'twice ' || extensions.gen_random_uuid(), false);
select set_config('qorpera_test.open_c1', public.qorpera_folder_open_upload('63500000-0000-4000-8000-000000000020',
	pg_temp.member(1), pg_temp.manifest(array[current_setting('qorpera_test.twice')]))::text, false);
select set_config('qorpera_test.open_c2', public.qorpera_folder_open_upload('63500000-0000-4000-8000-000000000020',
	pg_temp.member(2), pg_temp.manifest(array[current_setting('qorpera_test.twice')]))::text, false);
-- For D: an intent listing an object already stored (whose confirm takes it KEY SHARE; a new row is invisible to others
-- until it commits anyway), and one every object of which is put, ready to seal.
select set_config('qorpera_test.open_d1', public.qorpera_folder_open_upload('63500000-0000-4000-8000-000000000020',
	pg_temp.member(1), pg_temp.manifest(array['race chunk one ']))::text, false);
select set_config('qorpera_test.open_d2', public.qorpera_folder_open_upload('63500000-0000-4000-8000-000000000020',
	pg_temp.actor('run_one'), pg_temp.manifest(array['held by seal']))::text, false);
select public.qorpera_folder_confirm_object('63500000-0000-4000-8000-000000000020', pg_temp.actor('run_one'),
	(current_setting('qorpera_test.open_d2')::jsonb ->> 'intentId')::uuid, pg_temp.hash(x), octet_length(convert_to(x, 'utf8')))
from unnest(array['held by seal', pg_temp.manifest(array['held by seal'])]) x;

-- B. Staging and downloads take no company-wide lock: they finish while another transaction holds the company row and
-- company_files for an update, the fence FOR UPDATE, and the run's job FOR UPDATE. (They only reference the company
-- row and company_files by key, which an update of either does not block.)
do $$
declare
	v jsonb := pg_temp.actor('run_one'); v_file jsonb := current_setting('qorpera_test.bytes_file')::jsonb;
	v_manifest text := pg_temp.manifest(array['unblocked']); v_open jsonb; v_call text;
begin
	perform dblink_exec('auth_one', 'begin');
	perform dblink_exec('auth_one', $q$update public.qorpera_profiles set name = name where id = '63500000-0000-4000-8000-000000000010'$q$);
	perform dblink_exec('auth_one', $q$update public.qorpera_company_files set updated_at = updated_at
		where environment_id = '63500000-0000-4000-8000-000000000020'$q$);
	perform * from dblink('auth_one', $q$select 1 from public.qorpera_folder_fences where profile_id = '63500000-0000-4000-8000-000000000010'
		for update$q$) as t(r integer);
	perform * from dblink('auth_one', format('select 1 from public.qorpera_runner_jobs where id = %L for update', v ->> 'jobId')) as t(r integer);
	foreach v_call in array array[
		format('select public.qorpera_folder_open_upload(%L, %L, %L)', '63500000-0000-4000-8000-000000000020', v::text, v_manifest),
		format('select public.qorpera_folder_authorize_object_download(%L, %L, %L)', '63500000-0000-4000-8000-000000000020', v::text,
			pg_temp.hash('race chunk two'))] loop
		perform dblink_send_query('auth_two', v_call);
		if not pg_temp.finishes_unblocked('auth_two', 'auth_one') then raise exception 'It waited on the company: %', v_call; end if;
		perform pg_temp.outcome('auth_two');
	end loop;
	v_open := current_setting('qorpera_test.open_b')::jsonb;
	foreach v_call in array array[
		pg_temp.sql_confirm(v, (v_open ->> 'intentId')::uuid, 'unblocked 2'),
		pg_temp.sql_confirm(v, (v_open ->> 'intentId')::uuid, pg_temp.manifest(array['unblocked 2'])),
		format('select public.qorpera_folder_seal_upload(%L, %L, %L)', '63500000-0000-4000-8000-000000000020', v::text, v_open ->> 'intentId'),
		format('select public.qorpera_folder_renew_upload(%L, %L, %L)', '63500000-0000-4000-8000-000000000020', v::text, v_open ->> 'intentId'),
		-- Replication of a folder-v2 object takes no fence either.
		format('select public.qorpera_authorize_profile_object_replication(%L, %L, 14)', '63500000-0000-4000-8000-000000000010',
			pg_temp.hash('race chunk two')),
		format('select public.qorpera_confirm_profile_object_replica(%L, %L, 14)', '63500000-0000-4000-8000-000000000010',
			pg_temp.hash('race chunk two')),
		format($q$insert into storage.objects(bucket_id, name, metadata, user_metadata) values ('qorpera-profile-objects', %L,
			'{"size":14}', '{"qorpera_nas_replica":true,"qorpera_nas_replica_bytes":"14"}')$q$,
			'63500000-0000-4000-8000-000000000010/' || pg_temp.hash('race chunk two'))] loop
		perform dblink_send_query('auth_two', v_call);
		if not pg_temp.finishes_unblocked('auth_two', 'auth_one') then raise exception 'It waited on the company: %', v_call; end if;
		if pg_temp.outcome('auth_two') <> 'ok' then raise exception 'Unblocked staging refused: %', v_call; end if;
	end loop;
	perform dblink_exec('auth_one', 'rollback');
end $$;

-- C. Two uploads of one hash: the second waits for the first's catalog row, then finds it; the object is stored and
-- counted once.
do $$
declare
	v_twice text := current_setting('qorpera_test.twice'); v_one uuid; v_two uuid; r jsonb; v_objects bigint;
begin
	v_one := (current_setting('qorpera_test.open_c1')::jsonb ->> 'intentId')::uuid;
	v_two := (current_setting('qorpera_test.open_c2')::jsonb ->> 'intentId')::uuid;
	v_objects := (select objects from public.qorpera_folder_storage_usage where profile_id = '63500000-0000-4000-8000-000000000010');
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', pg_temp.sql_confirm(pg_temp.member(1), v_one, v_twice)) as t(r jsonb);
	perform dblink_send_query('auth_two', pg_temp.sql_confirm(pg_temp.member(2), v_two, v_twice));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The second upload waits for the first''s row'; end if;
	perform dblink_exec('auth_one', 'commit');
	r := pg_temp.result('auth_two');
	if (r ->> 'stored')::boolean or (select objects from public.qorpera_folder_storage_usage
		where profile_id = '63500000-0000-4000-8000-000000000010') <> v_objects + 1 then
		raise exception 'One hash, stored and counted once: %', r; end if;
end $$;

-- D. Staging's own references lock too (G1): open's present objects, a confirmed object and seal's objects are held
-- KEY SHARE until their transaction ends.
do $$
declare
	v_d1 uuid := (current_setting('qorpera_test.open_d1')::jsonb ->> 'intentId')::uuid;
	v_d2 uuid := (current_setting('qorpera_test.open_d2')::jsonb ->> 'intentId')::uuid;
	v_call text; v_sha text;
begin
	for v_call, v_sha in select * from (values
		(format('select public.qorpera_folder_open_upload(%L, %L, %L)', '63500000-0000-4000-8000-000000000020', '{"kind":"platform"}',
			pg_temp.manifest(array['race chunk one '])), pg_temp.hash('race chunk one ')),
		(pg_temp.sql_confirm(pg_temp.member(1), v_d1, 'race chunk one '), pg_temp.hash('race chunk one ')),
		(format('select public.qorpera_folder_seal_upload(%L, %L, %L)', '63500000-0000-4000-8000-000000000020',
			pg_temp.actor('run_one')::text, v_d2), pg_temp.hash('held by seal'))) c(call, sha)
	loop
		perform dblink_exec('auth_one', 'begin');
		perform * from dblink('auth_one', v_call) as t(r jsonb);
		perform dblink_send_query('auth_two', format('select 1 from public.qorpera_profile_objects where profile_id = %L and sha256 = %L for update',
			'63500000-0000-4000-8000-000000000010', v_sha));
		if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'It holds its object: %', v_call; end if;
		perform dblink_exec('auth_one', 'rollback');
		perform pg_temp.outcome('auth_two');
	end loop;
end $$;

-- E. Replication waits for a company being purged (the purge holds the company row FOR UPDATE), so it never copies an
-- object of a company that is going.
do $$
begin
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', $q$select 1 from public.qorpera_profiles where id = '63500000-0000-4000-8000-000000000010' for update$q$)
		as t(r integer);
	perform dblink_send_query('auth_two', format('select public.qorpera_authorize_profile_object_replication(%L, %L, 14)',
		'63500000-0000-4000-8000-000000000010', pg_temp.hash('race chunk two')));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'Replication waits for the purge'; end if;
	perform dblink_exec('auth_one', 'rollback');
	if pg_temp.outcome('auth_two') <> 'ok' then raise exception 'Replication goes on once the company stays'; end if;
end $$;

-- F. Races with nothing to wait for: a commit of a file whose seal is still in flight finds no proof and refuses it,
-- without waiting; an open during a stop that has not committed goes ahead, and the next put after the stop refuses.
do $$
declare
	v jsonb := pg_temp.actor('run_one'); r jsonb; v_manifest text := pg_temp.manifest(array['held by seal']); v_open jsonb;
begin
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', format('select public.qorpera_folder_seal_upload(%L, %L, %L)', '63500000-0000-4000-8000-000000000020',
		v::text, current_setting('qorpera_test.open_d2')::jsonb ->> 'intentId')) as t(r jsonb);
	perform dblink_send_query('auth_two', pg_temp.sql_commit(v, 'bytes-race-seal', jsonb_build_array(jsonb_build_object('op','write',
		'path','shared/sealing.txt','file',jsonb_build_object('manifestSha256', pg_temp.hash(v_manifest),
			'fileSha256', pg_temp.hash('held by seal'), 'bytes', 12, 'mediaType', 'text/plain', 'executable', false)))));
	if not pg_temp.finishes_unblocked('auth_two', 'auth_one') then raise exception 'A commit waited for a seal'; end if;
	r := pg_temp.result('auth_two');
	if r -> 'units' -> 0 ->> 'reason' is distinct from 'bytes_unverified' then raise exception 'No proof yet: %', r; end if;
	perform dblink_exec('auth_one', 'rollback');

	perform dblink_exec('auth_one', 'begin');
	perform dblink_exec('auth_one', $q$insert into public.qorpera_company_execution_pauses(profile_id, reason, paused_by_user_id)
		values ('63500000-0000-4000-8000-000000000010', 'race', '63500000-0000-4000-8000-000000000001')$q$);
	perform dblink_send_query('auth_two', format('select public.qorpera_folder_open_upload(%L, %L, %L)',
		'63500000-0000-4000-8000-000000000020', pg_temp.member(1)::text, pg_temp.manifest(array['during stop'])));
	if not pg_temp.finishes_unblocked('auth_two', 'auth_one') then raise exception 'An open waited for a stop'; end if;
	v_open := pg_temp.result('auth_two');
	perform dblink_exec('auth_one', 'commit');
	begin
		perform public.qorpera_folder_authorize_object_upload('63500000-0000-4000-8000-000000000020', pg_temp.member(1),
			(v_open ->> 'intentId')::uuid, pg_temp.hash('during stop'), 11);
		raise exception 'The put after the stop is refused';
	exception when object_not_in_prerequisite_state then null;
	end;
	delete from public.qorpera_company_execution_pauses where profile_id = '63500000-0000-4000-8000-000000000010';
end $$;

select dblink_disconnect(name) from unnest(array['auth_one','auth_two','auth_three']) name;

-- The committed fixture leaves the shared suite database.
set session_replication_role = replica;
-- (Foreign-key cascades do not run under replica: each table of C1d is cleared by name. The catalog and 635's Storage
-- rows stay, as after 635, so the fixture can run again; the replica row B wrote goes.)
delete from public.qorpera_folder_file_chunks where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_upload_intent_objects where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_upload_intents where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_storage_usage where profile_id = '63500000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects'
	and name = '63500000-0000-4000-8000-000000000010/' || encode(extensions.digest('race chunk two', 'sha256'), 'hex');
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
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '63500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intent_objects where profile_id = '63500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_file_chunks where profile_id = '63500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_storage_usage where profile_id = '63500000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
