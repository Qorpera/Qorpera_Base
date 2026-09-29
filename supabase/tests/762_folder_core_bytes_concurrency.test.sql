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

select set_config('qorpera_test.bytes_file', pg_temp.stage_v2(pg_temp.member(2), array['race chunk one ', 'race chunk two'])::text, false);

-- A. Step 6: a commit holds the manifest and every chunk of each file it writes or copies KEY SHARE until it ends, so
-- a lock that would remove one (C1d-2's GC mark) waits for it.
do $$
declare
	v jsonb := pg_temp.actor('run_one'); v_file jsonb := current_setting('qorpera_test.bytes_file')::jsonb; v_sha text;
begin
	foreach v_sha in array array[v_file ->> 'manifestSha256', pg_temp.hash('race chunk one '), pg_temp.hash('race chunk two'),
		pg_temp.hash('alpha')] loop
		perform dblink_exec('auth_one', 'begin');
		perform * from dblink('auth_one', pg_temp.sql_commit(v, 'bytes-hold-1', jsonb_build_array(
			jsonb_build_object('op','write','path','shared/bytes.txt','file',v_file),
			jsonb_build_object('op','copy','from','shared/a.txt','to','shared/a-copy.txt')))) as t(r jsonb);
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
select set_config('qorpera_test.open_c1', public.qorpera_folder_open_upload('63500000-0000-4000-8000-000000000020',
	pg_temp.member(1), pg_temp.manifest(array['twice']))::text, false);
select set_config('qorpera_test.open_c2', public.qorpera_folder_open_upload('63500000-0000-4000-8000-000000000020',
	pg_temp.member(2), pg_temp.manifest(array['twice']))::text, false);

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
		format('select public.qorpera_folder_renew_upload(%L, %L, %L)', '63500000-0000-4000-8000-000000000020', v::text, v_open ->> 'intentId')] loop
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
	v_manifest text := pg_temp.manifest(array['twice']); v_one uuid; v_two uuid; r jsonb; v_objects bigint;
begin
	v_one := (current_setting('qorpera_test.open_c1')::jsonb ->> 'intentId')::uuid;
	v_two := (current_setting('qorpera_test.open_c2')::jsonb ->> 'intentId')::uuid;
	v_objects := (select objects from public.qorpera_folder_storage_usage where profile_id = '63500000-0000-4000-8000-000000000010');
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', pg_temp.sql_confirm(pg_temp.member(1), v_one, 'twice')) as t(r jsonb);
	perform dblink_send_query('auth_two', pg_temp.sql_confirm(pg_temp.member(2), v_two, 'twice'));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The second upload waits for the first''s row'; end if;
	perform dblink_exec('auth_one', 'commit');
	r := pg_temp.result('auth_two');
	if (r ->> 'stored')::boolean or (select objects from public.qorpera_folder_storage_usage
		where profile_id = '63500000-0000-4000-8000-000000000010') <> v_objects + 1 then
		raise exception 'One hash, stored and counted once: %', r; end if;
end $$;

select dblink_disconnect(name) from unnest(array['auth_one','auth_two','auth_three']) name;

-- The committed fixture leaves the shared suite database.
set session_replication_role = replica;
delete from public.qorpera_folder_file_chunks where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_upload_intents where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_storage_usage where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_verified_company_file_objects where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_profile_objects where profile_id = '63500000-0000-4000-8000-000000000010';
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
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '63500000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
