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

-- Verified version-2 bytes for a text, as the object gateway leaves them: the platform stages them (C1D §9.3).
create function pg_temp.manifest_v2(p_text text) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/plain","executable":false,"chunks":[%s]}',
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'), octet_length(convert_to(p_text, 'utf8')),
		case when p_text = '' then '' else format('{"sha256":"%s","bytes":%s}', encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'),
			octet_length(convert_to(p_text, 'utf8'))) end)
$$;
-- Opens an intent for a manifest as the actor, confirms each object the open did not report present (the manifest's
-- chunks and the manifest itself, by hash and size, as the gateway does once it has stored them), and seals it.
create function pg_temp.seal_v2(p_env uuid, p_actor jsonb, p_manifest text) returns jsonb language plpgsql as $$
declare v_open jsonb := public.qorpera_folder_open_upload(p_env, p_actor, p_manifest); v_object jsonb;
begin
	for v_object in select c from jsonb_array_elements(p_manifest::jsonb -> 'chunks') c
		union all select jsonb_build_object('sha256', encode(extensions.digest(convert_to(p_manifest, 'utf8'), 'sha256'), 'hex'),
			'bytes', octet_length(convert_to(p_manifest, 'utf8'))) loop
		if not (v_open -> 'present') ? (v_object ->> 'sha256') then
			perform public.qorpera_folder_confirm_object(p_env, p_actor, (v_open ->> 'intentId')::uuid, v_object ->> 'sha256',
				(v_object ->> 'bytes')::bigint);
		end if;
	end loop;
	return public.qorpera_folder_seal_upload(p_env, p_actor, (v_open ->> 'intentId')::uuid);
end $$;
-- The files pg_temp.stage made, which were version 1 before C5 and so exempt from possession.
create temp table fixture_files(manifest_sha256 text primary key, manifest_text text not null);
-- The platform stages the text in each folder-v2 environment of the company (an intent is one environment's).
create function pg_temp.stage(p_text text) returns jsonb language plpgsql as $$
declare v_env uuid; v_seal jsonb; v_manifest text := pg_temp.manifest_v2(p_text);
begin
	for v_env in select environment_id from public.qorpera_company_files where profile_id = '63100000-0000-4000-8000-000000000010'
		and core = 'folder-v2' order by environment_id loop
		v_seal := pg_temp.seal_v2(v_env, '{"kind":"platform"}', v_manifest);
		if v_seal ->> 'state' is distinct from 'sealed' then raise exception 'Fixture staging: %', v_seal; end if;
	end loop;
	if v_seal is null then raise exception 'Fixture staging: the company has no folder-v2 environment'; end if;
	insert into pg_temp.fixture_files values (v_seal -> 'file' ->> 'manifestSha256', v_manifest) on conflict do nothing;
	return v_seal -> 'file';
end $$;
-- A version-2 file is held to possession (C1D §3): before an actor other than the platform commits units, it stages
-- each of their files pg_temp.stage made itself, as its own upload would, unless it holds an unexpired sealed intent
-- for it already. A file a test stages any other way is left alone. An actor that may not stage (42501) or a stopped
-- company (55000) is left to the commit's own refusal; any other error is a fixture defect and surfaces.
create function pg_temp.possess(p_env uuid, p_actor jsonb, p_units jsonb) returns void language plpgsql as $$
declare v_manifest text;
begin
	if p_actor ->> 'kind' is not distinct from 'platform' or jsonb_typeof(p_units) is distinct from 'array' then return; end if;
	for v_manifest in select distinct s.manifest_text from jsonb_array_elements(p_units) u
		cross join lateral (select u -> 'file' as f union all select c -> 'file' from jsonb_array_elements(
			case when jsonb_typeof(u -> 'contents') = 'array' then u -> 'contents' else '[]'::jsonb end) c) refs
		join pg_temp.fixture_files s on s.manifest_sha256 = refs.f ->> 'manifestSha256'
		where not exists (select 1 from public.qorpera_folder_upload_intents i where i.environment_id = p_env
			and i.manifest_sha256 = s.manifest_sha256 and i.state = 'sealed' and i.expires_at > clock_timestamp()
			and i.actor_kind = p_actor ->> 'kind' and i.scope_id = public.qorpera_folder_upload_scope(p_actor)) loop
		begin
			perform pg_temp.seal_v2(p_env, p_actor, v_manifest);
		exception when insufficient_privilege or object_not_in_prerequisite_state then null;
		end;
	end loop;
end $$;
select set_config('qorpera_test.race_one', pg_temp.stage('race one')::text, false);
select set_config('qorpera_test.race_two', pg_temp.stage('race two')::text, false);
-- The owner commits both files in the races, and takes possession of them now: its sealed intents must be committed
-- for the other connections to see, and a race's own transaction stages nothing (sql_commit then finds them held).
select pg_temp.possess('63100000-0000-4000-8000-000000000020', '{"kind":"member","userId":"63100000-0000-4000-8000-000000000001"}',
	jsonb_build_array(jsonb_build_object('op','write','path','race-one','file',current_setting('qorpera_test.race_one')::jsonb),
		jsonb_build_object('op','write','path','race-two','file',current_setting('qorpera_test.race_two')::jsonb)));

-- A commit's SQL for another connection, as the owner, after taking possession of its files in this one.
create function pg_temp.sql_commit(p_key text, p_units jsonb) returns text language plpgsql as $$
begin
	perform pg_temp.possess('63100000-0000-4000-8000-000000000020', '{"kind":"member","userId":"63100000-0000-4000-8000-000000000001"}',
		p_units);
	return format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '63100000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"63100000-0000-4000-8000-000000000001"}', p_key, p_units::text);
end $$;
create function pg_temp.commit(p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('63100000-0000-4000-8000-000000000020', '{"kind":"member","userId":"63100000-0000-4000-8000-000000000001"}',
		p_units);
	return public.qorpera_folder_commit('63100000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"63100000-0000-4000-8000-000000000001"}', p_key, p_units);
end $$;
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
delete from public.qorpera_folder_conflict_copies where environment_id = '63100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '63100000-0000-4000-8000-000000000020';
-- Version-2 objects are catalog rows of the object gateway (no Storage mirror, no link to the company), so they go by
-- hand, with their proofs and chunk rows; the intents go with the company.
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
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '63100000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '63100000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
