-- Company folder core, C1a: concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-CORE.md §3, §4). Two other
-- connections race real commits: disjoint paths never wait; the same path waits and then conflicts; an
-- absent path is claimed; a subtree delete and a create inside it serialize both ways; reads never wait.
-- The fixture is committed so the other connections can see it.

insert into auth.users(id,email) values
	('63100000-0000-4000-8000-000000000001','folder-race-owner@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('63100000-0000-4000-8000-000000000010','Folder race fixture','63100000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('63100000-0000-4000-8000-000000000010','63100000-0000-4000-8000-000000000001','folder-race-owner@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('63100000-0000-4000-8000-000000000020','63100000-0000-4000-8000-000000000010','Environment',1,'63100000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select public.qorpera_folder_enable('63100000-0000-4000-8000-000000000020');

create function pg_temp.stage(p_text text) returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','63100000-0000-4000-8000-000000000010/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',
		jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))))::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','63100000-0000-4000-8000-000000000010/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file('63100000-0000-4000-8000-000000000010',v_manifest);
	return jsonb_build_object('manifestSha256',v_manifest_hash,'fileSha256',v_hash,'bytes',octet_length(p_text),
		'mediaType','text/plain','executable',false);
end $$;
select set_config('qorpera_test.race_one', pg_temp.stage('race one')::text, false);
select set_config('qorpera_test.race_two', pg_temp.stage('race two')::text, false);

create function pg_temp.sql_commit(p_key text, p_units jsonb) returns text language sql as $$
	select format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '63100000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"63100000-0000-4000-8000-000000000001"}', p_key, p_units::text)
$$;
create function pg_temp.commit(p_key text, p_units jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_commit('63100000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"63100000-0000-4000-8000-000000000001"}', p_key, p_units)
$$;
create function pg_temp.version(p_path text) returns text language sql as $$
	select public.qorpera_folder_read('63100000-0000-4000-8000-000000000020', '{"kind":"platform"}', p_path) -> 'entry' ->> 'version'
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '63100000-0000-4000-8000-000000000020'
$$;
create function pg_temp.one(p_units jsonb) returns jsonb language sql as $$ select p_units -> 'units' -> 0 $$;
-- True while the connection is still running its query after p_seconds.
create function pg_temp.still_busy(p_conn text, p_seconds numeric) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + make_interval(secs => p_seconds::double precision);
begin
	loop
		if dblink_is_busy(p_conn) = 0 then return false; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.05);
	end loop;
	return true;
end $$;
-- Reads a sent query's result and drains the connection (dblink needs one more, empty, result).
create function pg_temp.result(p_conn text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	select r into v from dblink_get_result(p_conn) as t(r jsonb);
	perform * from dblink_get_result(p_conn) as t(r jsonb);
	return v;
end $$;

select pg_temp.commit('race-setup-1', jsonb_build_array(
	jsonb_build_object('op','write','path','a.txt','file',current_setting('qorpera_test.race_one')::jsonb),
	jsonb_build_object('op','mkdir','path','dir'), jsonb_build_object('op','mkdir','path','dir2'),
	jsonb_build_object('op','mkdir','path','dir3')));

select dblink_connect('race_one', 'dbname=qorpera_test');
select dblink_connect('race_two', 'dbname=qorpera_test');
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"service_role"}'$q$)
from unnest(array['race_one','race_two']) name;

-- A. Disjoint paths never wait: one connection holds a.txt; another commits b.txt at once.
do $$
declare r jsonb;
begin
	perform dblink_exec('race_one', 'begin');
	perform * from dblink('race_one', $q$select 1 from public.qorpera_folder_entries
		where environment_id = '63100000-0000-4000-8000-000000000020' and key_text = 'a.txt' for update$q$) as t(x integer);
	perform dblink_send_query('race_two', pg_temp.sql_commit('race-a-b', jsonb_build_array(jsonb_build_object('op','write',
		'path','b.txt','file',current_setting('qorpera_test.race_two')::jsonb))));
	if pg_temp.still_busy('race_two', 5) then raise exception 'A disjoint write waited for another path'; end if;
	r := pg_temp.one(pg_temp.result('race_two'));
	if r ->> 'outcome' <> 'saved' then raise exception 'Disjoint write: %', r; end if;
	perform dblink_exec('race_one', 'rollback');
end $$;

-- B. The same path waits, then conflicts: nobody's work is overwritten.
do $$
declare r jsonb; v text := pg_temp.version('a.txt');
begin
	perform dblink_exec('race_one', 'begin');
	perform * from dblink('race_one', pg_temp.sql_commit('race-b-1', jsonb_build_array(jsonb_build_object('op','write',
		'path','a.txt','expectedVersion',v,'file',current_setting('qorpera_test.race_two')::jsonb)))) as t(r jsonb);
	perform dblink_send_query('race_two', pg_temp.sql_commit('race-b-2', jsonb_build_array(jsonb_build_object('op','write',
		'path','a.txt','expectedVersion',v,'file',current_setting('qorpera_test.race_one')::jsonb))));
	if not pg_temp.still_busy('race_two', 1) then raise exception 'A write to a locked path did not wait'; end if;
	perform dblink_exec('race_one', 'commit');
	r := pg_temp.one(pg_temp.result('race_two'));
	if r ->> 'outcome' <> 'conflict' or r ->> 'reason' <> 'version_changed' then raise exception 'Same-path race: %', r; end if;
end $$;

-- C. An absent path is claimed: the second creator waits, then finds it taken.
do $$
declare r jsonb;
begin
	perform dblink_exec('race_one', 'begin');
	perform * from dblink('race_one', pg_temp.sql_commit('race-c-1', jsonb_build_array(jsonb_build_object('op','write',
		'path','new.txt','file',current_setting('qorpera_test.race_one')::jsonb)))) as t(r jsonb);
	perform dblink_send_query('race_two', pg_temp.sql_commit('race-c-2', jsonb_build_array(jsonb_build_object('op','write',
		'path','new.txt','file',current_setting('qorpera_test.race_two')::jsonb))));
	if not pg_temp.still_busy('race_two', 1) then raise exception 'A second creator did not wait for the claim'; end if;
	perform dblink_exec('race_one', 'commit');
	r := pg_temp.one(pg_temp.result('race_two'));
	if r ->> 'outcome' <> 'conflict' or r ->> 'reason' <> 'exists' then raise exception 'Absent-path race: %', r; end if;
end $$;

-- D. A subtree delete first: a create inside it waits, then finds its folder gone.
do $$
declare r jsonb;
begin
	perform dblink_exec('race_one', 'begin');
	perform * from dblink('race_one', pg_temp.sql_commit('race-d-1', jsonb_build_array(jsonb_build_object('op','delete',
		'path','dir','expectedVersion',pg_temp.version('dir'),'asOfSeq',pg_temp.seq())))) as t(r jsonb);
	perform dblink_send_query('race_two', pg_temp.sql_commit('race-d-2', jsonb_build_array(jsonb_build_object('op','write',
		'path','dir/f.txt','file',current_setting('qorpera_test.race_one')::jsonb))));
	if not pg_temp.still_busy('race_two', 1) then raise exception 'A create inside a folder being deleted did not wait'; end if;
	perform dblink_exec('race_one', 'commit');
	r := pg_temp.one(pg_temp.result('race_two'));
	if r ->> 'outcome' <> 'refused' or r ->> 'reason' <> 'parent_missing' then raise exception 'Delete-then-create race: %', r; end if;
end $$;

-- E. A create inside first: a subtree delete that saw the folder before waits, then refuses the unseen file.
do $$
declare r jsonb; s bigint := pg_temp.seq(); v text := pg_temp.version('dir2');
begin
	perform dblink_exec('race_one', 'begin');
	perform * from dblink('race_one', pg_temp.sql_commit('race-e-1', jsonb_build_array(jsonb_build_object('op','write',
		'path','dir2/f.txt','file',current_setting('qorpera_test.race_one')::jsonb)))) as t(r jsonb);
	perform dblink_send_query('race_two', pg_temp.sql_commit('race-e-2', jsonb_build_array(jsonb_build_object('op','delete',
		'path','dir2','expectedVersion',v,'asOfSeq',s))));
	if not pg_temp.still_busy('race_two', 1) then raise exception 'A subtree delete did not wait for a create inside'; end if;
	perform dblink_exec('race_one', 'commit');
	r := pg_temp.one(pg_temp.result('race_two'));
	if r ->> 'outcome' <> 'conflict' or r ->> 'reason' <> 'unseen_change' then raise exception 'Create-then-delete race: %', r; end if;
end $$;

-- F. Reads and listings never wait, even while a commit holds the path and the clock.
do $$
declare v text := pg_temp.version('a.txt'); s bigint := pg_temp.seq(); r jsonb;
begin
	perform dblink_exec('race_one', 'begin');
	perform * from dblink('race_one', pg_temp.sql_commit('race-f-1', jsonb_build_array(jsonb_build_object('op','write',
		'path','a.txt','expectedVersion',v,'file',current_setting('qorpera_test.race_one')::jsonb)))) as t(r jsonb);
	perform dblink_send_query('race_two', format($q$select public.qorpera_folder_read(%L,'{"kind":"platform"}','a.txt')
		|| jsonb_build_object('list', public.qorpera_folder_list(%L,'{"kind":"platform"}','',null,100,true))$q$,
		'63100000-0000-4000-8000-000000000020','63100000-0000-4000-8000-000000000020'));
	if pg_temp.still_busy('race_two', 5) then raise exception 'A read waited for a commit'; end if;
	r := pg_temp.result('race_two');
	if r -> 'entry' ->> 'version' <> v or (r ->> 'asOfSeq')::bigint <> s or (r -> 'list' ->> 'asOfSeq')::bigint <> s then
		raise exception 'A read must answer from before the open commit: %', r; end if;
	perform dblink_exec('race_one', 'rollback');
end $$;

-- G. Two disjoint commits racing both land, with consecutive sequence numbers and one journal row each.
do $$
declare s bigint := pg_temp.seq(); r1 jsonb; r2 jsonb;
begin
	perform dblink_send_query('race_one', pg_temp.sql_commit('race-g-1', '[{"op":"mkdir","path":"dir3/one"}]'));
	perform dblink_send_query('race_two', pg_temp.sql_commit('race-g-2', '[{"op":"mkdir","path":"dir3/two"}]'));
	if pg_temp.still_busy('race_one', 5) or pg_temp.still_busy('race_two', 5) then raise exception 'Disjoint commits stalled'; end if;
	r1 := pg_temp.result('race_one'); r2 := pg_temp.result('race_two');
	if array[(r1 ->> 'seq')::bigint, (r2 ->> 'seq')::bigint] <@ array[s + 1, s + 2] is not true or r1 ->> 'seq' = r2 ->> 'seq'
		or pg_temp.seq() <> s + 2 then raise exception 'Racing commits: % %', r1, r2; end if;
	if (select count(*) from public.qorpera_folder_journal where environment_id = '63100000-0000-4000-8000-000000000020'
		and seq > s) <> 2 then raise exception 'Each racing commit has one journal row'; end if;
	if exists (select 1 from public.qorpera_folder_entries where kind = 'claim') then raise exception 'A claim outlived a race'; end if;
end $$;

select dblink_disconnect('race_one');
select dblink_disconnect('race_two');
