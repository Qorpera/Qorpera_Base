-- Company folder core, C1a: concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-CORE.md §3, §4). Two other
-- connections race real commits: disjoint paths never wait; the same path waits and then conflicts; an
-- absent path is claimed; a subtree delete and a create inside it serialize both ways; reads never wait; a
-- copy's source cannot change under it. The fixture is committed so the other connections can see it, and
-- removed at the end.

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
	jsonb_build_object('op','mkdir','path','dir3'),
	jsonb_build_object('op','mkdir','path','msrc'),
	jsonb_build_object('op','write','path','msrc/x','file',current_setting('qorpera_test.race_one')::jsonb),
	jsonb_build_object('op','write','path','mzzz.txt','file',current_setting('qorpera_test.race_one')::jsonb),
	jsonb_build_object('op','mkdir','path','csrc'),
	jsonb_build_object('op','write','path','csrc/x','file',current_setting('qorpera_test.race_one')::jsonb),
	jsonb_build_object('op','write','path','czzz.txt','file',current_setting('qorpera_test.race_one')::jsonb),
	jsonb_build_object('op','mkdir','path','ksrc'),
	jsonb_build_object('op','write','path','ksrc/x','file',current_setting('qorpera_test.race_one')::jsonb)));

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['race_zero','race_one','race_two']) name;
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"service_role"}'$q$)
from unnest(array['race_zero','race_one','race_two']) name;
select set_config('qorpera_test.pid_' || name, pid::text, false)
from unnest(array['race_zero','race_one','race_two']) name, lateral dblink(name, 'select pg_backend_pid()') as t(pid integer);

-- True once p_waiter is blocked by p_holder (a real lock wait, not just a slow query), within 60 s.
create function pg_temp.waits_for(p_waiter text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if current_setting('qorpera_test.pid_' || p_holder)::integer = any (pg_blocking_pids(current_setting('qorpera_test.pid_' || p_waiter)::integer)) then
			return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
-- True when p_conn's query finishes without ever waiting on p_holder. A wait on a transaction p_holder keeps
-- open lasts until it ends, so sampling sees it; wall-clock time is not the test, since a loaded machine is slow.
create function pg_temp.finishes_unblocked(p_conn text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if dblink_is_busy(p_conn) = 0 then return true; end if;
		if current_setting('qorpera_test.pid_' || p_holder)::integer = any (pg_blocking_pids(current_setting('qorpera_test.pid_' || p_conn)::integer))
			or clock_timestamp() > v_until then
			return false; end if;
		perform pg_sleep(0.02);
	end loop;
end $$;

-- A. Disjoint paths never wait: one connection holds a.txt; another commits b.txt at once.
do $$
declare r jsonb;
begin
	perform dblink_exec('race_one', 'begin');
	perform * from dblink('race_one', $q$select 1 from public.qorpera_folder_entries
		where environment_id = '63100000-0000-4000-8000-000000000020' and key_text = 'a.txt' for update$q$) as t(x integer);
	perform dblink_send_query('race_two', pg_temp.sql_commit('race-a-b', jsonb_build_array(jsonb_build_object('op','write',
		'path','b.txt','file',current_setting('qorpera_test.race_two')::jsonb))));
	if not pg_temp.finishes_unblocked('race_two', 'race_one') then raise exception 'A disjoint write waited for another path'; end if;
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
	if not pg_temp.waits_for('race_two', 'race_one') then raise exception 'A write to a locked path did not wait'; end if;
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
	if not pg_temp.waits_for('race_two', 'race_one') then raise exception 'A second creator did not wait for the claim'; end if;
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
	if not pg_temp.waits_for('race_two', 'race_one') then raise exception 'A create inside a folder being deleted did not wait'; end if;
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
	if not pg_temp.waits_for('race_two', 'race_one') then raise exception 'A subtree delete did not wait for a create inside'; end if;
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
	if not pg_temp.finishes_unblocked('race_two', 'race_one') then raise exception 'A read waited for a commit'; end if;
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
	if pg_temp.still_busy('race_one', 60) or pg_temp.still_busy('race_two', 60) then raise exception 'Disjoint commits stalled'; end if;
	r1 := pg_temp.result('race_one'); r2 := pg_temp.result('race_two');
	if array[(r1 ->> 'seq')::bigint, (r2 ->> 'seq')::bigint] <@ array[s + 1, s + 2] is not true or r1 ->> 'seq' = r2 ->> 'seq'
		or pg_temp.seq() <> s + 2 then raise exception 'Racing commits: % %', r1, r2; end if;
	if (select count(*) from public.qorpera_folder_journal where environment_id = '63100000-0000-4000-8000-000000000020'
		and seq > s) <> 2 then raise exception 'Each racing commit has one journal row'; end if;
	if exists (select 1 from public.qorpera_folder_entries where kind = 'claim') then raise exception 'A claim outlived a race'; end if;
end $$;

-- H. Review round 1: a move (and a copy) into dst held up behind another lock, while a second change set
-- writes under dst and in the source. Every write holds its ancestors, so the second waits at dst instead
-- of claiming a key under it; both finish, with no deadlock.
do $$
declare v_op text; r1 jsonb; r2 jsonb; v_source_outcome text;
begin
	foreach v_op in array array['move','copy'] loop
		perform dblink_exec('race_zero', 'begin');
		perform * from dblink('race_zero', format($q$select 1 from public.qorpera_folder_entries
			where environment_id = '63100000-0000-4000-8000-000000000020' and key_text = %L for update$q$,
			left(v_op, 1) || 'zzz.txt')) as t(x integer);
		perform dblink_send_query('race_one', pg_temp.sql_commit('race-h1-' || v_op, jsonb_build_array(
			case when v_op = 'move' then jsonb_build_object('op','move','from','msrc','to','mdst','expectedVersion',pg_temp.version('msrc'),
				'asOfSeq',pg_temp.seq()) else jsonb_build_object('op','copy','from','csrc','to','cdst') end,
			jsonb_build_object('op','write','path',left(v_op, 1) || 'zzz.txt','expectedVersion',pg_temp.version(left(v_op, 1) || 'zzz.txt'),
				'file',current_setting('qorpera_test.race_two')::jsonb))));
		if not pg_temp.waits_for('race_one', 'race_zero') then raise exception '% did not wait behind the held file', v_op; end if;
		perform dblink_send_query('race_two', pg_temp.sql_commit('race-h2-' || v_op, jsonb_build_array(
			jsonb_build_object('op','write','path',left(v_op, 1) || 'dst/x','file',current_setting('qorpera_test.race_two')::jsonb),
			jsonb_build_object('op','write','path',left(v_op, 1) || 'src/x','expectedVersion',pg_temp.version(left(v_op, 1) || 'src/x'),
				'file',current_setting('qorpera_test.race_two')::jsonb))));
		if not pg_temp.waits_for('race_two', 'race_one') then raise exception 'A write under dst did not wait for the % target', v_op; end if;
		perform dblink_exec('race_zero', 'rollback');
		if pg_temp.still_busy('race_one', 60) or pg_temp.still_busy('race_two', 60) then raise exception '% race stalled', v_op; end if;
		r1 := pg_temp.result('race_one'); r2 := pg_temp.result('race_two');
		v_source_outcome := case when v_op = 'move' then 'conflict' else 'saved' end;
		if r1 -> 'units' -> 0 ->> 'outcome' <> 'saved' or r1 -> 'units' -> 1 ->> 'outcome' <> 'saved'
			or r2 -> 'units' -> 0 ->> 'reason' <> 'exists'
			or r2 -> 'units' -> 1 ->> 'outcome' <> v_source_outcome then
			raise exception '% race outcomes: % %', v_op, r1, r2; end if;
	end loop;
end $$;

-- I. Review round 2: a copy holds its source, so a write inside it waits and lands after the copy, which
-- carries exactly what it checked.
do $$
declare r jsonb;
begin
	perform dblink_exec('race_one', 'begin');
	perform * from dblink('race_one', pg_temp.sql_commit('race-i-1', '[{"op":"copy","from":"ksrc","to":"kdst"}]')) as t(r jsonb);
	perform dblink_send_query('race_two', pg_temp.sql_commit('race-i-2', jsonb_build_array(jsonb_build_object('op','write',
		'path','ksrc/late.txt','file',current_setting('qorpera_test.race_two')::jsonb))));
	if not pg_temp.waits_for('race_two', 'race_one') then raise exception 'A write inside a copy source did not wait for the copy'; end if;
	perform dblink_exec('race_one', 'commit');
	r := pg_temp.one(pg_temp.result('race_two'));
	if r ->> 'outcome' <> 'saved' or (pg_temp.version('kdst/x') is null) or pg_temp.version('kdst/late.txt') is not null then
		raise exception 'Copy-source race: %', r; end if;
end $$;

select dblink_disconnect(name) from unnest(array['race_zero','race_one','race_two']) name;

-- Every race left the folder whole: no claims, no orphans, no lost versions.
do $$
declare v_claims bigint; v_orphans bigint; v_lost bigint;
begin
	select count(*) filter (where e.kind = 'claim'),
		count(*) filter (where strpos(e.path, '/') > 0 and not exists (select 1 from public.qorpera_folder_entries p
			where p.environment_id = e.environment_id and p.key_sha256 = e.parent_key_sha256 and p.kind = 'folder'))
	into v_claims, v_orphans
	from public.qorpera_folder_entries e where e.environment_id = '63100000-0000-4000-8000-000000000020';
	select count(*) into v_lost from public.qorpera_folder_path_versions v
	where v.environment_id = '63100000-0000-4000-8000-000000000020' and v.op in ('write','mkdir','copy','move_in')
		and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = v.environment_id and e.version = v.version)
		and not exists (select 1 from public.qorpera_folder_path_versions w where w.environment_id = v.environment_id and w.prior_version = v.version);
	if v_claims + v_orphans + v_lost <> 0 then
		raise exception 'Folder invariants after the races: % claims, % orphans, % lost versions', v_claims, v_orphans, v_lost; end if;
end $$;

-- The committed fixture leaves the shared suite database.
delete from public.qorpera_folder_journal where environment_id = '63100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '63100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '63100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '63100000-0000-4000-8000-000000000020';
delete from public.qorpera_profiles where id = '63100000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '63100000-0000-4000-8000-000000000010/%';
delete from auth.users where id = '63100000-0000-4000-8000-000000000001';
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '63100000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_clocks where environment_id = '63100000-0000-4000-8000-000000000020') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
