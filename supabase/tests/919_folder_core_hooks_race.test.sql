-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core C4, E1 (migration 20260930060000) under concurrency: a hook's removal and a write of its file
-- serialize on the hook row at rank 5 (#815 review r1 F1). A writer's commit of the file holds the hook FOR SHARE; the
-- removal (FOR NO KEY UPDATE) waits for it, and once both commit, the next claim of the hook finds the file and says it
-- goes. A write sent after the removal committed is refused. A mailbox's creation and a new mail domain serialize on the
-- mail settings (review r2 F2). On 648's committed company; the fixture goes at the end.

-- The company's QorperaOS/connections/ folder, which 648's seed does not make.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'e1-race-mkdir-1', '[{"op":"mkdir","path":"QorperaOS/connections"}]'), 1,
	'saved') \g /dev/null

-- A folder-v2 hook, made directly (its creation is 912's), and its first claim by writer A, finished.
with h as (insert into public.qorpera_event_hooks(profile_id, environment_id, name, purpose, proof, address, max_body_bytes,
	per_minute, created_by_user_id)
	values ('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'race', 'The race hook.', 'address',
		translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_'), 65536, 60,
		'64800000-0000-4000-8000-000000000001') returning id)
select set_config('qorpera_test.hook', (select id::text from h), false) \g /dev/null

create function pg_temp.claim() returns jsonb language sql as $$
	select public.qorpera_claim_connection_file('91900000-0000-4000-8000-00000000000a', 60)
$$;
-- The file a claim says, as a unit: the settings and kind as the parse, a text that hashes, its bytes staged and committed
-- now so another connection can commit them.
create function pg_temp.hook_unit(p_claim jsonb, p_path text, p_expected uuid default null) returns jsonb language sql as $$
	select pg_temp.write(p_path, 'hook', E'---\n' || (p_claim -> 'settings')::text || E'\n---\nThe race hook.',
		(p_claim -> 'settings') || '{"kind":"hook","purpose":"The race hook."}'::jsonb, p_expected)
$$;
select set_config('qorpera_test.claim', pg_temp.claim()::text, false) \g /dev/null
do $$
declare c jsonb := current_setting('qorpera_test.claim')::jsonb;
begin
	if c ->> 'subjectKind' <> 'hook' or (c ->> 'secretId') <> current_setting('qorpera_test.hook') or c ->> 'present' <> 'true' then
		raise exception 'The race hook''s first claim: %', c; end if;
	perform public.qorpera_finish_connection_file('91900000-0000-4000-8000-00000000000a', (c ->> 'secretId')::uuid,
		(c ->> 'generation')::bigint, null, 'hook');
end $$;
-- The write's unit, its bytes staged now (committed), for fence_one to send.
select set_config('qorpera_test.unit', pg_temp.hook_unit(current_setting('qorpera_test.claim')::jsonb,
	'QorperaOS/connections/hook-race.md')::text, false) \g /dev/null
select dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}'$q$);

-- R1. fence_one commits the file as the platform in an open transaction; fence_two's removal waits for it, at the hook row.
select dblink_exec('fence_one', 'begin');
do $$
declare r jsonb;
begin
	select x into r from dblink('fence_one', format('select public.qorpera_folder_commit(%L, %L, %L, %L)',
		'64800000-0000-4000-8000-000000000020', '{"kind":"platform"}', 'e1-race-write-1',
		jsonb_build_array(current_setting('qorpera_test.unit')::jsonb)::text)) as t(x jsonb);
	if r -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'R1: the write is saved: %', r; end if;
end $$;
select dblink_send_query('fence_two', format('select public.qorpera_set_event_hook_status(%L, %L)::text',
	current_setting('qorpera_test.hook'), 'removed'));
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'R1: the removal does not wait for the write'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_event_hooks'::regclass then
		raise exception 'R1: the removal waits at %, not at the hook', pg_temp.queued_on('fence_two'); end if;
end $$;
select dblink_exec('fence_one', 'commit');
do $$
declare v_outcome text;
begin
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'R1: the removal did not end'; end if;
	v_outcome := pg_temp.outcome('fence_two');
	if v_outcome <> 'ok' then raise exception 'R1: the removal: %', v_outcome; end if;
end $$;
-- The next claim says the file goes, and names it: nothing is left behind.
do $$
declare c jsonb := pg_temp.claim();
begin
	if c ->> 'present' <> 'false' or c -> 'current' ->> 'path' is distinct from 'QorperaOS/connections/hook-race.md' then
		raise exception 'R1: after the removal the claim finds the file: %', c; end if;
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', c ->> 'operationKey', jsonb_build_array(jsonb_build_object('op',
		'delete', 'path', c -> 'current' ->> 'path', 'expectedVersion', c -> 'current' ->> 'version'))), 1, 'saved');
	perform public.qorpera_finish_connection_file('91900000-0000-4000-8000-00000000000a', (c ->> 'secretId')::uuid,
		(c ->> 'generation')::bigint, null, 'hook');
end $$;

-- R2. A write sent after the removal committed (a writer whose claim predates it) is refused under its lock.
do $$
declare r jsonb;
begin
	select x into r from dblink('fence_one', format('select public.qorpera_folder_commit(%L, %L, %L, %L)',
		'64800000-0000-4000-8000-000000000020', '{"kind":"platform"}', 'e1-race-write-2',
		jsonb_build_array(current_setting('qorpera_test.unit')::jsonb)::text)) as t(x jsonb);
	if r -> 'units' -> 0 ->> 'outcome' is distinct from 'refused' then raise exception 'R2: a late write is refused: %', r; end if;
end $$;

-- R3. A new mail domain and a mailbox's creation (review r2 F2). fence_one changes the domain in an open transaction (its
-- marks find no mailbox yet); fence_two's creation waits for it at the mail settings, after its own locks, and the
-- mailbox's claim then shows the new address. The domain is put back at the end.
select set_config('qorpera_test.domain', coalesce((select domain from public.qorpera_mail_settings), ''), false) \g /dev/null
update public.qorpera_mail_settings set domain = 'inbox.example.test';
select dblink_exec('fence_one', 'begin');
select dblink_exec('fence_one', $q$update public.qorpera_mail_settings set domain = 'mail.example.test'$q$);
select dblink_send_query('fence_two', format('select public.qorpera_create_company_mailbox(%L, %L, %L, %L)::text',
	'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'support', 'Customer support.'));
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'R3: the creation does not wait for the new domain'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_mail_settings'::regclass then
		raise exception 'R3: the creation waits at %, not at the mail settings', pg_temp.queued_on('fence_two'); end if;
end $$;
select dblink_exec('fence_one', 'commit');
do $$
declare v_outcome text; c jsonb;
begin
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'R3: the creation did not end'; end if;
	v_outcome := pg_temp.outcome('fence_two');
	if v_outcome <> 'ok' then raise exception 'R3: the creation: %', v_outcome; end if;
	c := pg_temp.claim();
	if c ->> 'subjectKind' is distinct from 'mailbox' or c ->> 'present' <> 'true'
		or c -> 'settings' ->> 'address' is distinct from 'support@mail.example.test' then
		raise exception 'R3: the new mailbox''s claim shows the new domain: %', c; end if;
	perform public.qorpera_finish_connection_file('91900000-0000-4000-8000-00000000000a', (c ->> 'secretId')::uuid,
		(c ->> 'generation')::bigint, null, 'mailbox');
end $$;
update public.qorpera_mail_settings set domain = nullif(current_setting('qorpera_test.domain'), '');

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 853 does).
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
	delete from public.qorpera_event_deliveries where hook_id in (select id from public.qorpera_event_hooks where profile_id = any (v_profiles));
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
		or exists (select 1 from public.qorpera_event_hooks where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_company_mailboxes where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_connection_file_marks where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_connection_file_work where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_hook_index where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
