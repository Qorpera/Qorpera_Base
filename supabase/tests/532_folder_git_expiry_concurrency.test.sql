-- @fixture 631_folder_core_concurrency.test.sql until "-- The owner commits both files in the races"
-- git's old objects (20260930446400; F3 step 5b, part 4) racing the upload intents' sweep (20260928349860). An object's
-- last two roots are an ended version under repo.git/objects/ and an upload intent that expired two hours ago. The
-- sweep removes the intent in one transaction while the expiry removes the version in another: each still sees the
-- other's root. The expiry queues the bytes all the same, so they wait for GC once both commit (its claim re-checks the
-- roots). The fixture is 631's, committed so the sweep's connection sees it, and removed at the end.

do $$
begin
	if not public.qorpera_folder_gc_company('63100000-0000-4000-8000-000000000010') then
		raise exception 'Folder GC does not serve the race fixture'; end if;
end $$;

-- The platform writes an object into code/acme/app/repo.git and prunes it. The object's intent expired two hours ago.
select set_config('qorpera_test.expiry_file', pg_temp.stage('expiry race object')::text, false);
do $$
declare env uuid := '63100000-0000-4000-8000-000000000020'; v_object text := 'code/acme/app/repo.git/objects/ab/' || repeat('d', 38);
	r jsonb;
begin
	r := public.qorpera_folder_commit(env, '{"kind":"platform"}', 'expiry-race-write',
		(select jsonb_agg(jsonb_build_object('op','mkdir','path',p) order by n) from unnest(array['code', 'code/acme',
			'code/acme/app', 'code/acme/app/repo.git', 'code/acme/app/repo.git/objects', 'code/acme/app/repo.git/objects/ab'])
			with ordinality t(p, n))
		|| jsonb_build_array(jsonb_build_object('op','write','path',v_object,
			'file',current_setting('qorpera_test.expiry_file')::jsonb)));
	if (select count(*) from jsonb_array_elements(r -> 'units') u where u ->> 'outcome' = 'saved') <> 7 then
		raise exception 'The write: %', r; end if;
	r := public.qorpera_folder_commit(env, '{"kind":"platform"}', 'expiry-race-prune', jsonb_build_array(
		jsonb_build_object('op','delete','path',v_object,'expectedVersion',
			public.qorpera_folder_read(env, '{"kind":"platform"}', v_object) -> 'entry' ->> 'version')));
	if r -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The prune: %', r; end if;
end $$;
select set_config('qorpera_test.expiry_intent', (select id::text from public.qorpera_folder_upload_intents
	where profile_id = '63100000-0000-4000-8000-000000000010'
		and manifest_sha256 = current_setting('qorpera_test.expiry_file')::jsonb ->> 'manifestSha256'), false);
update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 hours'
where id = current_setting('qorpera_test.expiry_intent')::uuid;

select dblink_connect('expiry_sweep', 'dbname=' || current_database());
select dblink_exec('expiry_sweep', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
set lock_timeout = '10s';

-- One transaction holds the expiry's cursor (so no scheduled run takes these versions), makes the versions 8 days old
-- and moves the cursor to just before them; it puts the cursor back at the end.
do $$
declare env uuid := '63100000-0000-4000-8000-000000000020'; v_profile uuid := '63100000-0000-4000-8000-000000000010';
	v_key bytea := extensions.digest(public.qorpera_folder_key('code/acme/app/repo.git/objects/ab/' || repeat('d', 38)), 'sha256');
	v_file jsonb := current_setting('qorpera_test.expiry_file')::jsonb;
	v_intent uuid := current_setting('qorpera_test.expiry_intent')::uuid;
	v_cursor public.qorpera_folder_git_expiry%rowtype; v_hashes text[]; v_first timestamptz; v jsonb; v_swept integer;
begin
	select array_agg(h order by h) into v_hashes from (select v_file ->> 'manifestSha256' as h
		union select chunk_sha256 from public.qorpera_folder_file_chunks
		where profile_id = v_profile and manifest_sha256 = v_file ->> 'manifestSha256') s;
	if cardinality(v_hashes) <> 2 or v_intent is null then raise exception 'Fixture: % / %', v_hashes, v_intent; end if;
	select * into v_cursor from public.qorpera_folder_git_expiry for update;
	update public.qorpera_folder_path_versions set created_at = created_at - interval '8 days'
	where environment_id = env and key_sha256 = v_key;
	select min(created_at) into v_first from public.qorpera_folder_path_versions where environment_id = env and key_sha256 = v_key;
	update public.qorpera_folder_git_expiry set after_at = v_first - interval '1 microsecond',
		after_version = '00000000-0000-0000-0000-000000000000';

	-- The sweep takes the intent and stays open. The version still roots the bytes there, so it queues nothing.
	perform dblink_exec('expiry_sweep', 'begin');
	select n into v_swept from dblink('expiry_sweep', 'select public.qorpera_folder_sweep_upload_intents(100)') as t(n integer);
	if v_swept < 1 or (select n from dblink('expiry_sweep', format('select count(*)::integer from public.qorpera_folder_upload_intents
			where id = %L', v_intent)) as t(n integer)) <> 0
		or (select n from dblink('expiry_sweep', format('select count(*)::integer from public.qorpera_folder_object_gc
			where profile_id = %L', v_profile)) as t(n integer)) <> 0 then
		raise exception 'The sweep took no intent, or queued bytes the version roots'; end if;

	-- Here the intent still roots them (its removal is not committed). The expiry removes the write and the prune.
	if not exists (select 1 from public.qorpera_folder_upload_intents where id = v_intent) then
		raise exception 'The intent''s removal is visible before its commit'; end if;
	v := public.qorpera_folder_git_versions_expire(10);
	perform dblink_exec('expiry_sweep', 'commit');

	if v <> jsonb_build_object('schema', 'qorpera.folder-git-expiry/v1', 'scanned', 2, 'expired', 2, 'queued', 2)
			or exists (select 1 from public.qorpera_folder_path_versions where environment_id = env and key_sha256 = v_key)
			or exists (select 1 from public.qorpera_folder_upload_intents where id = v_intent) then
		raise exception 'The expiry: %', v; end if;
	if (select array_agg(sha256 order by sha256) from public.qorpera_folder_object_gc where profile_id = v_profile)
			is distinct from v_hashes then
		raise exception 'Both roots went and the bytes wait for no GC'; end if;
	update public.qorpera_folder_git_expiry set after_at = v_cursor.after_at, after_version = v_cursor.after_version;
end $$;

select dblink_disconnect('expiry_sweep');

-- The committed fixture leaves the shared suite database (as 631).
delete from public.qorpera_folder_journal where environment_id = '63100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '63100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '63100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_conflict_copies where environment_id = '63100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '63100000-0000-4000-8000-000000000020';
-- Version-2 objects are catalog rows of the object gateway (no Storage mirror, no link to the company), so they go by
-- hand, with their proofs, chunk rows and GC rows; the intents go with the company.
delete from public.qorpera_profile_objects where profile_id = '63100000-0000-4000-8000-000000000010';
delete from public.qorpera_profiles where id = '63100000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '63100000-0000-4000-8000-000000000010/%';
delete from auth.users where id = '63100000-0000-4000-8000-000000000001';
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '63100000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_clocks where environment_id = '63100000-0000-4000-8000-000000000020')
		or exists (select 1 from storage.objects where name like '63100000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '63100000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_object_gc where profile_id = '63100000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '63100000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '63100000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
