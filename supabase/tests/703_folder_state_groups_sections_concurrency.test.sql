-- Company state files, F2-2, under concurrency (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §4): a save that
-- renames a group chat takes the company row FOR KEY SHARE before the chat's room (FOR NO KEY UPDATE), as snapshot-v1
-- posting takes the company row (qorpera_lock_profile_gc_fence) before the room and the operation clock; posting is
-- played by its first locks, in its order. Either may start first. On folder-v2 (C1c-3a) posting takes the company row
-- KEY SHARE and its room FOR SHARE, where the save waits for it (661 I and J). The fixture is committed so other connections see it, and
-- removed at the end. Waits are detected with pg_blocking_pids, never by wall-clock time.

insert into auth.users(id,email) values
	('70300000-0000-4000-8000-000000000001','groups-race-owner@example.test'),
	('70300000-0000-4000-8000-000000000002','groups-race-member@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('70300000-0000-4000-8000-000000000010','Nordlys Group Race','70300000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('70300000-0000-4000-8000-000000000010','70300000-0000-4000-8000-000000000001','groups-race-owner@example.test','Owner','owner'),
	('70300000-0000-4000-8000-000000000010','70300000-0000-4000-8000-000000000002','groups-race-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('70300000-0000-4000-8000-000000000020','70300000-0000-4000-8000-000000000010','Environment',1,'70300000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', false) \g /dev/null
select public.qorpera_folder_enable('70300000-0000-4000-8000-000000000020') \g /dev/null
-- Verified version-2 bytes for a text, as the object gateway leaves them: the platform stages them.
create function pg_temp.manifest_v2(p_text text) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/markdown","executable":false,"chunks":[%s]}',
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
-- The platform stages the text in each folder-v2 environment of the company (an intent is one environment's).
create function pg_temp.stage(p_text text, p_profile uuid default '70300000-0000-4000-8000-000000000010') returns jsonb language plpgsql as $$
declare v_env uuid; v_seal jsonb;
begin
	for v_env in select environment_id from public.qorpera_company_files where profile_id = p_profile and core = 'folder-v2'
		order by environment_id loop
		v_seal := pg_temp.seal_v2(v_env, '{"kind":"platform"}', pg_temp.manifest_v2(p_text));
		if v_seal ->> 'state' is distinct from 'sealed' then raise exception 'Fixture staging: %', v_seal; end if;
	end loop;
	if v_seal is null then raise exception 'Fixture staging: the company has no folder-v2 environment'; end if;
	return v_seal -> 'file';
end $$;
-- A version-2 file is held to possession (C1D §3): before an actor other than the platform commits units, it stages
-- each of their files itself, as its own upload would. An actor that may not stage (42501) or a stopped company (55000)
-- is left to the commit's own refusal; any other error is a fixture defect and surfaces.
create function pg_temp.possess(p_env uuid, p_actor jsonb, p_units jsonb) returns void language plpgsql as $$
declare v_manifest text;
begin
	if p_actor ->> 'kind' is not distinct from 'platform' or jsonb_typeof(p_units) is distinct from 'array' then return; end if;
	for v_manifest in select distinct i.manifest_text from jsonb_array_elements(p_units) u
		cross join lateral (select u -> 'file' as f union all select c -> 'file' from jsonb_array_elements(
			case when jsonb_typeof(u -> 'contents') = 'array' then u -> 'contents' else '[]'::jsonb end) c) refs
		join public.qorpera_folder_upload_intents i on i.environment_id = p_env and i.manifest_sha256 = refs.f ->> 'manifestSha256'
		where refs.f is not null loop
		begin
			perform pg_temp.seal_v2(p_env, p_actor, v_manifest);
		exception when insufficient_privilege or object_not_in_prerequisite_state then null;
		end;
	end loop;
end $$;
-- A commit's SQL for another connection, as its actor, after taking possession of the actor's files in this one.
create function pg_temp.sql_commit(p_env text, p_actor text, p_key text, p_units text) returns text language plpgsql as $$
begin
	perform pg_temp.possess(p_env::uuid, p_actor::jsonb, p_units::jsonb);
	return format('select public.qorpera_folder_commit(%L, %L, %L, %L)', p_env, p_actor, p_key, p_units);
end $$;

-- A structured entry as the TS parser sends it.
create function pg_temp.entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.write(p_path text, p_kind text, p_text text, p_parse jsonb, p_expected uuid default null) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text),
		'structured', jsonb_build_array(pg_temp.entry(p_path, p_kind, p_text, p_parse)))
		|| case when p_expected is not null then jsonb_build_object('expectedVersion', p_expected) else '{}'::jsonb end
$$;
create function pg_temp.agent_text(p_id uuid, p_name text, p_kind text default 'agent', p_status text default 'active')
returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Sales\nkind: %s\nstatus: %s\n---\nSell.\n', p_id, p_name, p_kind, p_status)
$$;
create function pg_temp.agent_parse(p_id uuid, p_name text, p_kind text default 'agent', p_status text default 'active')
returns jsonb language sql as $$
	select jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Sales','agentKind',p_kind,'status',p_status,
		'colour',null,'figure',null,'model',null,'effort',null,'instructions','Sell.')
$$;
-- A new agent folder with its agent.md, as one unit.
create function pg_temp.hire(p_handle text, p_id uuid, p_name text, p_kind text default 'agent') returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','QorperaOS/agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_name, p_kind))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('QorperaOS/agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.agent_text(p_id, p_name, p_kind), pg_temp.agent_parse(p_id, p_name, p_kind))))
$$;
create function pg_temp.vision(p_name text) returns jsonb language sql as $$
	select pg_temp.write('QorperaOS/vision/vision.md', 'vision', E'# ' || p_name || E'\n\n## What we build\n',
		jsonb_build_object('kind','vision','name',p_name),
		(select version from public.qorpera_folder_entries where environment_id = '70300000-0000-4000-8000-000000000020'
			and key_text = 'qorperaos/vision/vision.md'))
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('70300000-0000-4000-8000-000000000020', p_actor, p_units);
	return public.qorpera_folder_commit('70300000-0000-4000-8000-000000000020', p_actor, p_key, p_units);
end $$;
create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"70300000-0000-4000-8000-000000000001"}'::jsonb
$$;
create function pg_temp.expect(p_result jsonb, p_unit integer, p_outcome text, p_reason text default null)
returns jsonb language plpgsql as $$
declare v jsonb := p_result -> 'units' -> (p_unit - 1);
begin
	if v ->> 'outcome' is distinct from p_outcome or v ->> 'reason' is distinct from p_reason then
		raise exception 'Unit % expected % (%), got %', p_unit, p_outcome, p_reason, p_result using errcode = 'QTF01'; end if;
	return v;
end $$;
create function pg_temp.version(p_key text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '70300000-0000-4000-8000-000000000020' and key_text = public.qorpera_folder_key(p_key)
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '70300000-0000-4000-8000-000000000020'
$$;
create function pg_temp.staff(p_id uuid) returns public.qorpera_profile_staff language sql as $$
	select * from public.qorpera_profile_staff where profile_id = '70300000-0000-4000-8000-000000000010' and staff_agent_id = p_id
$$;

create function pg_temp.group_text(p_id uuid, p_name text, p_agents uuid[], p_people uuid[], p_subtitle text default null)
returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\n%sagents:\n%speople:\n%s---\nPlan the launch.\n', p_id, p_name,
		case when p_subtitle is null then '' else format(E'subtitle: "%s"\n', p_subtitle) end,
		(select string_agg(format(E'  - %s\n', a), '') from unnest(p_agents) a),
		coalesce((select string_agg(format(E'  - %s\n', a), '') from unnest(p_people) a), ''))
$$;
create function pg_temp.group_parse(p_id uuid, p_name text, p_agents uuid[], p_people uuid[], p_subtitle text default null)
returns jsonb language sql as $$
	select jsonb_build_object('kind','group','id',p_id,'name',p_name,'subtitle',p_subtitle,'agents',to_jsonb(p_agents),
		'people',to_jsonb(coalesce(p_people, '{}'::uuid[])),'purpose','Plan the launch.')
$$;
-- A new group chat folder with its group.md, as one unit.
create function pg_temp.new_group(p_handle text, p_id uuid, p_name text, p_agents uuid[], p_people uuid[]) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','QorperaOS/agents/groups/' || p_handle,
		'contents', jsonb_build_array(jsonb_build_object('path','group.md','kind','file',
			'file',pg_temp.stage(pg_temp.group_text(p_id, p_name, p_agents, p_people)))),
		'structured', jsonb_build_array(pg_temp.entry('QorperaOS/agents/groups/' || p_handle || '/group.md', 'group',
			pg_temp.group_text(p_id, p_name, p_agents, p_people), pg_temp.group_parse(p_id, p_name, p_agents, p_people))))
$$;
-- An edit of a group.md, with its parse given.
create function pg_temp.edit_group(p_handle text, p_parse jsonb) returns jsonb language sql as $$
	select pg_temp.write('QorperaOS/agents/groups/' || p_handle || '/group.md', 'group', 'group ' || p_parse::text, p_parse,
		pg_temp.version('QorperaOS/agents/groups/' || p_handle || '/group.md'))
$$;
-- The creation commit, two hires and a group chat, committed.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'race-seed-0001', jsonb_build_array(
	jsonb_build_object('op','mkdir','path','QorperaOS'), jsonb_build_object('op','mkdir','path','QorperaOS/vision'), pg_temp.vision('Nordlys Group Race'),
	jsonb_build_object('op','mkdir','path','QorperaOS/agents'),
	pg_temp.write('QorperaOS/agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
	pg_temp.hire('co-founder', '70300000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'),
	jsonb_build_object('op','mkdir','path','QorperaOS/agents/groups'))), 7, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'race-hire-0001', jsonb_build_array(
	pg_temp.hire('nora-dahl', '70300000-0000-4000-8000-0000000000a1', 'Nora Dahl'), pg_temp.hire('otto', '70300000-0000-4000-8000-0000000000a2', 'Otto'))), 2, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'race-group-0001', jsonb_build_array(
	pg_temp.new_group('launch', '70300000-0000-4000-8000-0000000000b1', 'Launch', array['70300000-0000-4000-8000-0000000000a1','70300000-0000-4000-8000-0000000000a2']::uuid[], array['70300000-0000-4000-8000-000000000001']::uuid[]))), 1, 'saved') \g /dev/null
select set_config('qorpera_test.state_room', '70300000-0000-4000-8000-0000000000b1', false) \g /dev/null
-- The rename, staged now: staging an object inside the save's own transaction would lock the company row itself.
select set_config('qorpera_test.state_rename', pg_temp.sql_commit('70300000-0000-4000-8000-000000000020',
	pg_temp.owner()::text, 'race-rename-0001', jsonb_build_array(pg_temp.edit_group('launch',
		pg_temp.group_parse('70300000-0000-4000-8000-0000000000b1', 'Launch team', array['70300000-0000-4000-8000-0000000000a1','70300000-0000-4000-8000-0000000000a2']::uuid[], array['70300000-0000-4000-8000-000000000001']::uuid[])))::text), false) \g /dev/null

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['srace_post','srace_save','srace_hold']) name;
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"service_role"}'$q$) from unnest(array['srace_post','srace_save','srace_hold']) name;
select set_config('qorpera_test.pid_' || name, pid::text, false)
from unnest(array['srace_post','srace_save','srace_hold']) name, lateral dblink(name, 'select pg_backend_pid()') as t(pid integer);

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

-- A. Posting holds the company row; the rename waits for it before it takes the chat's room, so posting then
-- takes the room and the operation clock at once.
do $$
declare v jsonb;
begin
	perform dblink_exec('srace_post', 'begin');
	perform * from dblink('srace_post', $q$select public.qorpera_lock_profile_gc_fence('70300000-0000-4000-8000-000000000010')::text$q$)
		as t(x text);
	perform dblink_send_query('srace_save', current_setting('qorpera_test.state_rename'));
	if not pg_temp.waits_for('srace_save', 'srace_post') then raise exception 'The rename must wait for the posting company row'; end if;
	-- The room is free: posting's next lock does not wait.
	perform * from dblink('srace_post', format('select 1 from public.qorpera_company_rooms where id = %L for share nowait',
		current_setting('qorpera_test.state_room'))) as t(x integer);
	perform * from dblink('srace_post', $q$select 1 from public.qorpera_profile_operation_clocks
		where profile_id = '70300000-0000-4000-8000-000000000010' for update nowait$q$) as t(x integer);
	perform dblink_exec('srace_post', 'rollback');
	select r into v from dblink_get_result('srace_save') as t(r jsonb);
	perform * from dblink_get_result('srace_save') as t(r jsonb);
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The rename saves once posting is done: %', v; end if;
	if (select name from public.qorpera_company_rooms where id = '70300000-0000-4000-8000-0000000000b1') is distinct from 'Launch team' then
		raise exception 'The rename reaches the room'; end if;
end $$;

-- C. The other order: the save holds the chat's room (it waits on a path another connection holds) and a post
-- starts. The post waits for the save at the company row, before the room, and both finish.
select set_config('qorpera_test.state_rename_back', pg_temp.sql_commit('70300000-0000-4000-8000-000000000020',
	pg_temp.owner()::text, 'race-rename-0002', jsonb_build_array(pg_temp.edit_group('launch',
		pg_temp.group_parse('70300000-0000-4000-8000-0000000000b1', 'Launch', array['70300000-0000-4000-8000-0000000000a1','70300000-0000-4000-8000-0000000000a2']::uuid[], array['70300000-0000-4000-8000-000000000001']::uuid[])))::text), false) \g /dev/null
do $$
declare v jsonb;
begin
	perform dblink_exec('srace_hold', 'begin');
	perform * from dblink('srace_hold', $q$select 1 from public.qorpera_folder_entries
		where environment_id = '70300000-0000-4000-8000-000000000020' and key_text = 'qorperaos/agents/groups/launch/group.md' for update$q$) as t(x integer);
	perform dblink_send_query('srace_save', current_setting('qorpera_test.state_rename_back'));
	if not pg_temp.waits_for('srace_save', 'srace_hold') then raise exception 'The rename must wait on the held path'; end if;
	-- The save now holds the company row KEY SHARE and the chat's room FOR NO KEY UPDATE.
	perform dblink_exec('srace_post', 'begin');
	perform dblink_send_query('srace_post', $q$select public.qorpera_lock_profile_gc_fence('70300000-0000-4000-8000-000000000010')::text$q$);
	if not pg_temp.waits_for('srace_post', 'srace_save') then raise exception 'The post must wait for the save at the company row'; end if;
	perform dblink_exec('srace_hold', 'rollback');
	select r into v from dblink_get_result('srace_save') as t(r jsonb);
	perform * from dblink_get_result('srace_save') as t(r jsonb);
	if v -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The rename saves before the post: %', v; end if;
	perform * from dblink_get_result('srace_post') as t(x text);
	perform * from dblink_get_result('srace_post') as t(x text);
	-- The post goes on to the room and the clock at once.
	perform * from dblink('srace_post', format('select 1 from public.qorpera_company_rooms where id = %L for share nowait',
		current_setting('qorpera_test.state_room'))) as t(x integer);
	perform * from dblink('srace_post', $q$select 1 from public.qorpera_profile_operation_clocks
		where profile_id = '70300000-0000-4000-8000-000000000010' for update nowait$q$) as t(x integer);
	perform dblink_exec('srace_post', 'rollback');
	if (select name from public.qorpera_company_rooms where id = '70300000-0000-4000-8000-0000000000b1') is distinct from 'Launch' then
		raise exception 'The rename back reaches the room'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['srace_post','srace_save','srace_hold']) name;

-- The committed fixture leaves the shared suite database.
set session_replication_role = replica;
delete from public.qorpera_folder_company_index where environment_id = '70300000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_journal where environment_id = '70300000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '70300000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '70300000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '70300000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_operation_keys where environment_id = '70300000-0000-4000-8000-000000000020';
delete from public.qorpera_company_cofounders where profile_id = '70300000-0000-4000-8000-000000000010';
delete from public.qorpera_company_room_members where room_id in (select id from public.qorpera_company_rooms where profile_id = '70300000-0000-4000-8000-000000000010');
delete from public.qorpera_company_rooms where profile_id = '70300000-0000-4000-8000-000000000010';
delete from public.qorpera_shared_sessions where profile_id = '70300000-0000-4000-8000-000000000010';
delete from public.qorpera_profile_staff where profile_id = '70300000-0000-4000-8000-000000000010';
set session_replication_role = origin;
-- With triggers on: version-2 objects are catalog rows of the object gateway (no Storage mirror), so they go by
-- hand, with their proofs and chunk rows; any Storage object takes its mirror row with it.
delete from public.qorpera_profile_objects where profile_id = '70300000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '70300000-0000-4000-8000-000000000010/%';
delete from public.qorpera_profiles where id = '70300000-0000-4000-8000-000000000010';
delete from auth.users where id in ('70300000-0000-4000-8000-000000000001','70300000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '70300000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_profile_staff where profile_id = '70300000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '70300000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '70300000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '70300000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '70300000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
