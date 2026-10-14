-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Chat images on folder-v2 (20260930260000) under concurrency. A post and the save or the sweep of the same input meet
-- at the conversation: the post takes it FOR UPDATE before it inserts the input (whose trigger checks the images), and
-- the save's and the sweep's memory commits take it FOR SHARE. So a post never lands without its images: the sweep first
-- makes the post wait and refuse; the post first makes the sweep wait and undo its delete; the save first lets the post
-- land beside an image it does not list; the post first makes the save refuse. A save that finds the generation raised
-- by an erase after its read saves on the second attempt. A company purge's row lock holds the save and the begin at
-- the company, before any upload row, and the sweep skips the company. On 648's committed company, in the Co-Founder's
-- thread; the fixture goes at the end.

-- The company's login pays for unattended work (as 818's).
set session_replication_role = replica;
update public.qorpera_provider_connection_versions set allow_autonomous = true where connection_id = '64800000-0000-4000-8000-0000000000b3';
update public.qorpera_execution_sponsor_versions set allow_autonomous = true where binding_id = '64800000-0000-4000-8000-0000000000b1';
set session_replication_role = origin;
select set_config('qorpera_test.cf_room', id::text, false), set_config('qorpera_test.cf_thread', session_id::text, false)
from public.qorpera_company_rooms where profile_id = '64800000-0000-4000-8000-000000000010'
	and bound_staff_agent_id = '64800000-0000-4000-8000-0000000000c0' \g /dev/null

-- The client input ids; an image staged as the platform, as the object gateway stages it; the image as an input lists it.
create function pg_temp.cid(p_n integer) returns uuid language sql immutable as $$
	select ('41200000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
create function pg_temp.image(p_text text) returns jsonb language plpgsql as $$
declare
	v_sha text := encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex');
	v_bytes integer := octet_length(convert_to(p_text, 'utf8')); v_seal jsonb;
begin
	v_seal := pg_temp.seal_v2('64800000-0000-4000-8000-000000000020', '{"kind":"platform"}', format('{"schema":"qorpera.cloud-file-manifest/v2",'
		'"fileSha256":"%s","bytes":%s,"mediaType":"image/png","executable":false,"chunks":[{"sha256":"%s","bytes":%s}]}',
		v_sha, v_bytes, v_sha, v_bytes));
	if v_seal ->> 'state' is distinct from 'sealed' then raise exception 'Fixture staging: %', v_seal; end if;
	return v_seal -> 'file';
end $$;
create function pg_temp.img(p_file jsonb) returns jsonb language sql immutable as $$
	select jsonb_build_object('objectSha256', p_file ->> 'fileSha256', 'bytes', p_file -> 'bytes', 'mediaType', p_file ->> 'mediaType')
$$;
-- The images, staged now and committed: staging inside a racing transaction would lock the company row.
select set_config('qorpera_test.image_' || n, pg_temp.image('race image ' || n)::text, false) from generate_series(1, 8) n \g /dev/null
create function pg_temp.f(p_n integer) returns jsonb language sql as $$
	select current_setting('qorpera_test.image_' || p_n)::jsonb
$$;

-- The owner's begin (the owner's claims for this statement only), the gateway's save (the service role's), and both.
create function pg_temp.begin_image(p_cid uuid, p_file jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}', true);
	r := public.qorpera_room_image_begin(current_setting('qorpera_test.cf_thread')::uuid, p_cid, p_file ->> 'fileSha256',
		(p_file ->> 'bytes')::bigint, p_file ->> 'mediaType');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return r;
end $$;
create function pg_temp.sql_save(p_cid uuid, p_file jsonb) returns text language sql as $$
	select format('select public.qorpera_room_image_commit(%L, %L, %L, %L)::text', '64800000-0000-4000-8000-000000000001',
		current_setting('qorpera_test.cf_thread'), p_cid, p_file)
$$;
create function pg_temp.upload(p_cid uuid, p_file jsonb) returns void language plpgsql as $$
begin
	perform pg_temp.begin_image(p_cid, p_file);
	perform public.qorpera_room_image_commit('64800000-0000-4000-8000-000000000001', current_setting('qorpera_test.cf_thread')::uuid,
		p_cid, p_file);
end $$;
-- The owner's post of an input with its images, on the company's login, for another connection; that connection's
-- transaction as the owner (its claims for the transaction only).
create function pg_temp.sql_post(p_cid uuid, p_images jsonb) returns text language sql as $$
	select format('select public.qorpera_post_company_room_message(%L, %L, %L, %L, 1)::text', current_setting('qorpera_test.cf_room'),
		p_cid, jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', 'Look', 'images', p_images),
		'64800000-0000-4000-8000-0000000000b1')
$$;
create function pg_temp.as_owner(p_conn text) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, 'begin');
	perform dblink_exec(p_conn, $q$set local request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}'$q$);
end $$;
-- Whether an image is a live file at its path; a posted input's images (null with no input); whether the upload row is
-- there; the row's last upload set a day and an hour back (committed).
create function pg_temp.live(p_cid uuid, p_file jsonb) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_room_image_entry('64800000-0000-4000-8000-000000000020',
		public.qorpera_room_image_path(current_setting('qorpera_test.cf_thread')::uuid, p_cid, pg_temp.img(p_file)), pg_temp.img(p_file)))
$$;
create function pg_temp.posted(p_cid uuid) returns jsonb language sql as $$
	select coalesce(body -> 'images', 'null'::jsonb) from public.qorpera_session_inputs
	where session_id = current_setting('qorpera_test.cf_thread')::uuid and client_input_id = p_cid
$$;
create function pg_temp.held(p_cid uuid) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_room_image_uploads where session_id = current_setting('qorpera_test.cf_thread')::uuid
		and client_input_id = p_cid)
$$;
create function pg_temp.age(p_cid uuid) returns void language sql as $$
	update public.qorpera_room_image_uploads set updated_at = clock_timestamp() - interval '25 hours'
	where session_id = current_setting('qorpera_test.cf_thread')::uuid and client_input_id = p_cid
$$;
-- A sent call's answer, and the connection drained.
create function pg_temp.answer(p_conn text) returns text language plpgsql as $$
declare v text;
begin
	select x into v from dblink_get_result(p_conn) as t(x text);
	begin
		perform * from dblink_get_result(p_conn) as t(x text);
	exception when others then null;
	end;
	return v;
end $$;

-- The Co-Founder's thread keeps its tree under its notebook.
do $$
begin
	if public.qorpera_room_image_root(current_setting('qorpera_test.cf_thread')::uuid) is distinct from 'agents/co-founder/memory/thread' then
		raise exception 'Fixture: the Co-Founder''s thread root is %',
			public.qorpera_room_image_root(current_setting('qorpera_test.cf_thread')::uuid); end if;
end $$;

-- A. The post first. fence_one has posted input 1 with its image, uploaded a day ago, and holds the conversation FOR
-- UPDATE; fence_two's sweep takes the company and the row, and its memory commit waits at the conversation. Once the
-- post commits, the sweep finds the input and undoes its delete: the image stays, and so does the row.
select pg_temp.upload(pg_temp.cid(1), pg_temp.f(1)) \g /dev/null
select pg_temp.age(pg_temp.cid(1)) \g /dev/null
select pg_temp.as_owner('fence_one') \g /dev/null
select * from dblink('fence_one', pg_temp.sql_post(pg_temp.cid(1), jsonb_build_array(pg_temp.img(pg_temp.f(1))))) as t(x text) \g /dev/null
select dblink_send_query('fence_two', 'select public.qorpera_room_image_orphan_sweep()::text');
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A: the sweep does not wait for the post'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'A: the sweep waits at %, not at the conversation', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
end $$;
do $$
declare v text;
begin
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'A: the sweep did not end'; end if;
	v := pg_temp.answer('fence_two');
	if v is distinct from '0' then raise exception 'A: the sweep beside the post swept %', v; end if;
	if pg_temp.posted(pg_temp.cid(1)) is distinct from jsonb_build_array(pg_temp.img(pg_temp.f(1)))
		or not pg_temp.live(pg_temp.cid(1), pg_temp.f(1)) or not pg_temp.held(pg_temp.cid(1)) then
		raise exception 'A: the posted image stays, and so does its row'; end if;
	if exists (select 1 from public.qorpera_folder_commits where environment_id = '64800000-0000-4000-8000-000000000020'
		and operation_key like 'chat-image-sweep:' || pg_temp.cid(1) || ':%') then
		raise exception 'A: the sweep''s commit is undone'; end if;
end $$;
-- The next sweep finds the input listing its image: only the row goes.
do $$
begin
	if public.qorpera_room_image_orphan_sweep() <> 1 or not pg_temp.live(pg_temp.cid(1), pg_temp.f(1)) or pg_temp.held(pg_temp.cid(1)) then
		raise exception 'A: the next sweep keeps the posted image and drops its row'; end if;
end $$;

-- B. The sweep first. fence_one's sweep has deleted the folder of input 2, uploaded a day ago and never posted, and
-- holds the conversation FOR SHARE; fence_two's post of it passes the early check (the file is still there for it) and
-- waits at the conversation. Once the sweep commits, the trigger finds the upload gone and the post refuses.
select pg_temp.upload(pg_temp.cid(2), pg_temp.f(2)) \g /dev/null
select pg_temp.age(pg_temp.cid(2)) \g /dev/null
select dblink_exec('fence_one', 'begin');
do $$
declare v text;
begin
	select x into v from dblink('fence_one', 'select public.qorpera_room_image_orphan_sweep()::text') as t(x text);
	if v is distinct from '1' then raise exception 'B: the open sweep swept %', v; end if;
end $$;
select pg_temp.as_owner('fence_two') \g /dev/null
select dblink_send_query('fence_two', pg_temp.sql_post(pg_temp.cid(2), jsonb_build_array(pg_temp.img(pg_temp.f(2)))));
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'B: the post does not wait for the sweep'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'B: the post waits at %, not at the conversation', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
end $$;
do $$
declare v_outcome text;
begin
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'B: the post did not end'; end if;
	v_outcome := pg_temp.outcome('fence_two');
	if v_outcome not like '42501 %Attachment bytes must be uploaded for this exact member input%' then
		raise exception 'B: the post after the sweep: %', v_outcome; end if;
	perform dblink_exec('fence_two', 'rollback');
	if pg_temp.posted(pg_temp.cid(2)) is not null or pg_temp.live(pg_temp.cid(2), pg_temp.f(2)) or pg_temp.held(pg_temp.cid(2)) then
		raise exception 'B: no input, no image and no row'; end if;
end $$;

-- C. The gateway's save and a post of the same input. C1: the save first. fence_one has saved a second image of input
-- 3 and holds the conversation FOR SHARE; fence_two's post of input 3 with the first image waits at the conversation
-- and lands once the save commits. No input lists the second image, so a day later the sweep deletes it and keeps the
-- first.
select pg_temp.upload(pg_temp.cid(3), pg_temp.f(3)) \g /dev/null
select pg_temp.begin_image(pg_temp.cid(3), pg_temp.f(4)) \g /dev/null
select dblink_exec('fence_one', 'begin');
select * from dblink('fence_one', pg_temp.sql_save(pg_temp.cid(3), pg_temp.f(4))) as t(x text) \g /dev/null
select pg_temp.as_owner('fence_two') \g /dev/null
select dblink_send_query('fence_two', pg_temp.sql_post(pg_temp.cid(3), jsonb_build_array(pg_temp.img(pg_temp.f(3)))));
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'C1: the post does not wait for the save'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'C1: the post waits at %, not at the conversation', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
end $$;
do $$
declare v_outcome text;
begin
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'C1: the post did not end'; end if;
	v_outcome := pg_temp.outcome('fence_two');
	if v_outcome <> 'ok' then raise exception 'C1: the post after the save: %', v_outcome; end if;
	perform dblink_exec('fence_two', 'commit');
	if pg_temp.posted(pg_temp.cid(3)) is distinct from jsonb_build_array(pg_temp.img(pg_temp.f(3)))
		or not pg_temp.live(pg_temp.cid(3), pg_temp.f(3)) or not pg_temp.live(pg_temp.cid(3), pg_temp.f(4)) then
		raise exception 'C1: the input lists the first image, and both are there'; end if;
end $$;
select pg_temp.age(pg_temp.cid(3)) \g /dev/null
do $$
begin
	if public.qorpera_room_image_orphan_sweep() <> 1 or not pg_temp.live(pg_temp.cid(3), pg_temp.f(3))
		or pg_temp.live(pg_temp.cid(3), pg_temp.f(4)) or pg_temp.held(pg_temp.cid(3)) then
		raise exception 'C1: the sweep deletes the image the input does not list, and the row'; end if;
end $$;

-- C2: the post first. fence_one has posted input 4 with its first image and holds the conversation FOR UPDATE;
-- fence_two's save of a second image waits at the conversation, then finds the input and refuses: a submitted input's
-- images do not change.
select pg_temp.upload(pg_temp.cid(4), pg_temp.f(5)) \g /dev/null
select pg_temp.begin_image(pg_temp.cid(4), pg_temp.f(6)) \g /dev/null
select pg_temp.as_owner('fence_one') \g /dev/null
select * from dblink('fence_one', pg_temp.sql_post(pg_temp.cid(4), jsonb_build_array(pg_temp.img(pg_temp.f(5))))) as t(x text) \g /dev/null
select dblink_send_query('fence_two', pg_temp.sql_save(pg_temp.cid(4), pg_temp.f(6)));
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'C2: the save does not wait for the post'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'C2: the save waits at %, not at the conversation', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
end $$;
do $$
declare v_outcome text;
begin
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'C2: the save did not end'; end if;
	v_outcome := pg_temp.outcome('fence_two');
	if v_outcome not like '42501 %Submitted input attachments cannot change%' then
		raise exception 'C2: the save after the post: %', v_outcome; end if;
	if pg_temp.posted(pg_temp.cid(4)) is distinct from jsonb_build_array(pg_temp.img(pg_temp.f(5)))
		or not pg_temp.live(pg_temp.cid(4), pg_temp.f(5)) or pg_temp.live(pg_temp.cid(4), pg_temp.f(6)) then
		raise exception 'C2: the input keeps its one image, and the second is not saved'; end if;
end $$;

-- D. An erase between the save's read of the generation and its lock. fence_one has raised the conversation's
-- generation (as M3's erase does) and holds it FOR UPDATE; fence_two's save of input 5 read the generation before and
-- waits at the conversation. Once the erase commits, the first memory commit is stale and saves nothing; the second
-- names the new generation and saves the image.
select pg_temp.begin_image(pg_temp.cid(5), pg_temp.f(7)) \g /dev/null
select set_config('qorpera_test.generation', memory_generation::text, false) from public.qorpera_shared_sessions
where id = current_setting('qorpera_test.cf_thread')::uuid \g /dev/null
select dblink_exec('fence_one', 'begin');
select dblink_exec('fence_one', format('set local session_replication_role = replica; '
	'update public.qorpera_shared_sessions set memory_generation = memory_generation + 1 where id = %L',
	current_setting('qorpera_test.cf_thread')));
select dblink_send_query('fence_two', pg_temp.sql_save(pg_temp.cid(5), pg_temp.f(7)));
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'D: the save does not wait for the erase'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'D: the save waits at %, not at the conversation', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
end $$;
do $$
declare v_outcome text; v_commits text;
begin
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'D: the save did not end'; end if;
	v_outcome := pg_temp.outcome('fence_two');
	if v_outcome <> 'ok' then raise exception 'D: the save after the erase: %', v_outcome; end if;
	select count(*) || '/' || count(*) filter (where exists (select 1 from jsonb_array_elements(c.units) u
			where u.value ->> 'reason' = 'memory_generation_stale'))
		into v_commits
	from public.qorpera_folder_commits c where c.environment_id = '64800000-0000-4000-8000-000000000020'
		and c.operation_key like 'chat-image:' || pg_temp.cid(5) || ':%';
	if v_commits <> '2/1' or not pg_temp.live(pg_temp.cid(5), pg_temp.f(7))
		or (select memory_generation from public.qorpera_shared_sessions where id = current_setting('qorpera_test.cf_thread')::uuid)
			<> current_setting('qorpera_test.generation')::bigint + 1 then
		raise exception 'D: one stale memory commit, then the image saved under the new generation (commits/stale %)', v_commits; end if;
end $$;

-- E. A company purge holds the company row FOR UPDATE before its cascade reaches the conversation and the uploads.
-- fence_two's save of input 6 waits for it at the company row, holding no upload row, and fence_four's begin of input
-- 7 waits there before it inserts one; the sweep skips the company without waiting. Once the purge is gone (rolled
-- back here), both go on.
select pg_temp.begin_image(pg_temp.cid(6), pg_temp.f(8)) \g /dev/null
select pg_temp.age(pg_temp.cid(6)) \g /dev/null
select dblink_exec('fence_one', 'begin');
select * from dblink('fence_one', 'select 1 from public.qorpera_profiles where id = ''64800000-0000-4000-8000-000000000010'' for update')
	as t(x integer) \g /dev/null
select dblink_send_query('fence_two', pg_temp.sql_save(pg_temp.cid(6), pg_temp.f(8)));
select pg_temp.as_owner('fence_four') \g /dev/null
select dblink_send_query('fence_four', format('select public.qorpera_room_image_begin(%L, %L, %L, %s, %L)::text',
	current_setting('qorpera_test.cf_thread'), pg_temp.cid(7), pg_temp.f(1) ->> 'fileSha256', pg_temp.f(1) ->> 'bytes', 'image/png'));
do $$
declare v text; v_conn text;
begin
	foreach v_conn in array array['fence_two', 'fence_four'] loop
		if not pg_temp.waits_for(v_conn, 'fence_one') then raise exception 'E: % does not wait for the purge', v_conn; end if;
		if pg_temp.queued_on(v_conn) is distinct from 'public.qorpera_profiles'::regclass then
			raise exception 'E: % waits at %, not at the company', v_conn, pg_temp.queued_on(v_conn); end if;
	end loop;
	if exists (select 1 from pg_locks where pid = current_setting('qorpera_test.pid_fence_four')::integer
			and relation = 'public.qorpera_room_image_uploads'::regclass and mode = 'RowExclusiveLock') then
		raise exception 'E: the begin inserted its row before the company'; end if;
	-- The save holds no upload row: another connection takes it at once.
	perform dblink_exec('fence_three', 'begin');
	perform * from dblink('fence_three', format('select 1 from public.qorpera_room_image_uploads where session_id = %L
		and client_input_id = %L for update nowait', current_setting('qorpera_test.cf_thread'), pg_temp.cid(6))) as t(x integer);
	perform dblink_exec('fence_three', 'rollback');
	perform dblink_send_query('fence_three', 'select public.qorpera_room_image_orphan_sweep()::text');
	if not pg_temp.finishes_unblocked('fence_three', 'fence_one') then raise exception 'E: the sweep waits for the purge'; end if;
	v := pg_temp.answer('fence_three');
	if v is distinct from '0' then raise exception 'E: the sweep beside the purge swept %', v; end if;
	perform dblink_exec('fence_one', 'rollback');
end $$;
do $$
declare v_outcome text; v_conn text;
begin
	foreach v_conn in array array['fence_two', 'fence_four'] loop
		if not pg_temp.finishes_unblocked(v_conn, 'fence_one') then raise exception 'E: % did not end', v_conn; end if;
		v_outcome := pg_temp.outcome(v_conn);
		if v_outcome <> 'ok' then raise exception 'E: % after the purge: %', v_conn, v_outcome; end if;
	end loop;
	perform dblink_exec('fence_four', 'commit');
	if not pg_temp.live(pg_temp.cid(6), pg_temp.f(8)) or not pg_temp.held(pg_temp.cid(7))
		or (select updated_at from public.qorpera_room_image_uploads where session_id = current_setting('qorpera_test.cf_thread')::uuid
			and client_input_id = pg_temp.cid(6)) < clock_timestamp() - interval '1 hour' then
		raise exception 'E: the save lands and renews its row, and the begin holds its input'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 944 does); the uploads go with the conversation.
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
		or exists (select 1 from public.qorpera_room_image_uploads where environment_id = '64800000-0000-4000-8000-000000000020') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
