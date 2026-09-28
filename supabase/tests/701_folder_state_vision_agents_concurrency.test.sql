-- Company state files, F2-1, under concurrency (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §4, "Lock order
-- with the triggers"). A save that writes a roster row takes the company row FOR KEY SHARE before the agent's thread
-- room and the company's operation clock, as posting takes the company row (qorpera_lock_profile_gc_fence) before
-- both; posting is played here by its first locks, in its order. Either may start first. The fixture is committed so other connections see it, and removed at the end. Waits are detected with
-- pg_blocking_pids, never by wall-clock time.

insert into auth.users(id,email) values
	('70100000-0000-4000-8000-000000000001','state-race-owner@example.test'),
	('70100000-0000-4000-8000-000000000002','state-race-member@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('70100000-0000-4000-8000-000000000010','Nordlys Race','70100000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('70100000-0000-4000-8000-000000000010','70100000-0000-4000-8000-000000000001','state-race-owner@example.test','Owner','owner'),
	('70100000-0000-4000-8000-000000000010','70100000-0000-4000-8000-000000000002','state-race-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('70100000-0000-4000-8000-000000000020','70100000-0000-4000-8000-000000000010','Environment',1,'70100000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', false) \g /dev/null
select public.qorpera_folder_enable('70100000-0000-4000-8000-000000000020') \g /dev/null
-- Verified bytes for a text, as the object gateway leaves them.
create function pg_temp.stage(p_text text, p_profile uuid default '70100000-0000-4000-8000-000000000010')
returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects',p_profile::text || '/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects',p_profile::text || '/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file(p_profile,v_manifest);
	return jsonb_build_object('manifestSha256',v_manifest_hash,'fileSha256',v_hash,'bytes',octet_length(p_text),
		'mediaType','text/markdown','executable',false);
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
	select jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_name, p_kind))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.agent_text(p_id, p_name, p_kind), pg_temp.agent_parse(p_id, p_name, p_kind))))
$$;
create function pg_temp.vision(p_name text) returns jsonb language sql as $$
	select pg_temp.write('vision/vision.md', 'vision', E'# ' || p_name || E'\n\n## What we build\n',
		jsonb_build_object('kind','vision','name',p_name),
		(select version from public.qorpera_folder_entries where environment_id = '70100000-0000-4000-8000-000000000020'
			and key_text = 'vision/vision.md'))
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_commit('70100000-0000-4000-8000-000000000020', p_actor, p_key, p_units)
$$;
create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"70100000-0000-4000-8000-000000000001"}'::jsonb
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
	select version from public.qorpera_folder_entries where environment_id = '70100000-0000-4000-8000-000000000020' and key_text = p_key
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '70100000-0000-4000-8000-000000000020'
$$;
create function pg_temp.staff(p_id uuid) returns public.qorpera_profile_staff language sql as $$
	select * from public.qorpera_profile_staff where profile_id = '70100000-0000-4000-8000-000000000010' and staff_agent_id = p_id
$$;

-- The creation commit and one hire, committed.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'race-seed-0001', jsonb_build_array(
	jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Race'),
	jsonb_build_object('op','mkdir','path','agents'),
	pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
	pg_temp.hire('co-founder', '70100000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'))), 5, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'race-hire-0001', jsonb_build_array(
	pg_temp.hire('nora-dahl', '70100000-0000-4000-8000-0000000000a1', 'Nora Dahl'))), 1, 'saved') \g /dev/null
select set_config('qorpera_test.state_room', (select id::text from public.qorpera_company_rooms
	where profile_id = '70100000-0000-4000-8000-000000000010' and bound_staff_agent_id = '70100000-0000-4000-8000-0000000000a1'), false) \g /dev/null
-- The rename, staged now: staging an object inside the save's own transaction would lock the company row itself.
select set_config('qorpera_test.state_rename', format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '70100000-0000-4000-8000-000000000020',
	pg_temp.owner()::text, 'race-rename-0001', jsonb_build_array(pg_temp.write('agents/nora-dahl/agent.md', 'agent',
		pg_temp.agent_text('70100000-0000-4000-8000-0000000000a1', 'Nora Skov'),
		pg_temp.agent_parse('70100000-0000-4000-8000-0000000000a1', 'Nora Skov'),
		pg_temp.version('agents/nora-dahl/agent.md')))::text), false) \g /dev/null

select dblink_connect(name, 'dbname=qorpera_test') from unnest(array['srace_post','srace_save','srace_hold']) name;
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

-- A. Posting holds the company row; the rename waits for it before it takes the agent's room, so posting then
-- takes the room at once. Before, the save took the room first and then waited on the company row inside the
-- thread trigger's company operation: 40P01.
do $$
declare v jsonb;
begin
	perform dblink_exec('srace_post', 'begin');
	perform * from dblink('srace_post', $q$select public.qorpera_lock_profile_gc_fence('70100000-0000-4000-8000-000000000010')::text$q$)
		as t(x text);
	perform dblink_send_query('srace_save', current_setting('qorpera_test.state_rename'));
	if not pg_temp.waits_for('srace_save', 'srace_post') then raise exception 'The rename must wait for the posting company row'; end if;
	-- The room is free: posting's next lock does not wait.
	perform * from dblink('srace_post', format('select 1 from public.qorpera_company_rooms where id = %L for share nowait',
		current_setting('qorpera_test.state_room'))) as t(x integer);
	perform dblink_exec('srace_post', 'rollback');
	select r into v from dblink_get_result('srace_save') as t(r jsonb);
	perform * from dblink_get_result('srace_save') as t(r jsonb);
	if v -> 'units' -> 0 ->> 'outcome' <> 'saved' then raise exception 'The rename saves once posting is done: %', v; end if;
	if (select display_name from public.qorpera_profile_staff where profile_id = '70100000-0000-4000-8000-000000000010'
		and staff_agent_id = '70100000-0000-4000-8000-0000000000a1') <> 'Nora Skov' then
		raise exception 'The rename reaches the roster'; end if;
end $$;

-- B. An instructions edit (no room) ends in the roster's company operation: the clock, then the company row.
-- Posting holds the company row and appends its own operations later; the edit waits before it takes the clock.
select set_config('qorpera_test.state_edit', format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '70100000-0000-4000-8000-000000000020',
	pg_temp.owner()::text, 'race-edit-0001', jsonb_build_array(pg_temp.write('agents/nora-dahl/agent.md', 'agent',
		replace(pg_temp.agent_text('70100000-0000-4000-8000-0000000000a1', 'Nora Skov'), 'Sell.', 'Sell more.'),
		pg_temp.agent_parse('70100000-0000-4000-8000-0000000000a1', 'Nora Skov') || '{"instructions":"Sell more."}',
		pg_temp.version('agents/nora-dahl/agent.md')))::text), false) \g /dev/null
do $$
declare v jsonb;
begin
	perform dblink_exec('srace_post', 'begin');
	perform * from dblink('srace_post', $q$select public.qorpera_lock_profile_gc_fence('70100000-0000-4000-8000-000000000010')::text$q$)
		as t(x text);
	perform dblink_send_query('srace_save', current_setting('qorpera_test.state_edit'));
	if not pg_temp.waits_for('srace_save', 'srace_post') then raise exception 'The edit must wait for the posting company row'; end if;
	-- The company's operation clock is free: posting's own operations do not wait.
	perform * from dblink('srace_post', $q$select 1 from public.qorpera_profile_operation_clocks
		where profile_id = '70100000-0000-4000-8000-000000000010' for update nowait$q$) as t(x integer);
	perform dblink_exec('srace_post', 'rollback');
	select r into v from dblink_get_result('srace_save') as t(r jsonb);
	perform * from dblink_get_result('srace_save') as t(r jsonb);
	if v -> 'units' -> 0 ->> 'outcome' <> 'saved' then raise exception 'The edit saves once posting is done: %', v; end if;
	if (select charter from public.qorpera_profile_staff where profile_id = '70100000-0000-4000-8000-000000000010'
		and staff_agent_id = '70100000-0000-4000-8000-0000000000a1') <> 'Sell more.' then
		raise exception 'The edit reaches the roster'; end if;
end $$;

-- C. The other order: the save holds its room (it waits on a path another connection holds) and a post
-- starts. The post waits for the save at the company row, before the room, and both finish.
select set_config('qorpera_test.state_rename_back', format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '70100000-0000-4000-8000-000000000020',
	pg_temp.owner()::text, 'race-rename-0002', jsonb_build_array(pg_temp.write('agents/nora-dahl/agent.md', 'agent',
		replace(pg_temp.agent_text('70100000-0000-4000-8000-0000000000a1', 'Nora Dahl'), 'Sell.', 'Sell more.'),
		pg_temp.agent_parse('70100000-0000-4000-8000-0000000000a1', 'Nora Dahl') || '{"instructions":"Sell more."}',
		pg_temp.version('agents/nora-dahl/agent.md')))::text), false) \g /dev/null
do $$
declare v jsonb;
begin
	perform dblink_exec('srace_hold', 'begin');
	perform * from dblink('srace_hold', $q$select 1 from public.qorpera_folder_entries
		where environment_id = '70100000-0000-4000-8000-000000000020' and key_text = 'agents/nora-dahl/agent.md' for update$q$) as t(x integer);
	perform dblink_send_query('srace_save', current_setting('qorpera_test.state_rename_back'));
	if not pg_temp.waits_for('srace_save', 'srace_hold') then raise exception 'The rename must wait on the held path'; end if;
	-- The save now holds the company row KEY SHARE and the room FOR UPDATE.
	perform dblink_exec('srace_post', 'begin');
	perform dblink_send_query('srace_post', $q$select public.qorpera_lock_profile_gc_fence('70100000-0000-4000-8000-000000000010')::text$q$);
	if not pg_temp.waits_for('srace_post', 'srace_save') then raise exception 'The post must wait for the save at the company row'; end if;
	perform dblink_exec('srace_hold', 'rollback');
	select r into v from dblink_get_result('srace_save') as t(r jsonb);
	perform * from dblink_get_result('srace_save') as t(r jsonb);
	if v -> 'units' -> 0 ->> 'outcome' <> 'saved' then raise exception 'The rename saves before the post: %', v; end if;
	perform * from dblink_get_result('srace_post') as t(x text);
	perform * from dblink_get_result('srace_post') as t(x text);
	-- The post goes on to the room and the clock at once.
	perform * from dblink('srace_post', format('select 1 from public.qorpera_company_rooms where id = %L for share nowait',
		current_setting('qorpera_test.state_room'))) as t(x integer);
	perform * from dblink('srace_post', $q$select 1 from public.qorpera_profile_operation_clocks
		where profile_id = '70100000-0000-4000-8000-000000000010' for update nowait$q$) as t(x integer);
	perform dblink_exec('srace_post', 'rollback');
	if (select display_name from public.qorpera_profile_staff where profile_id = '70100000-0000-4000-8000-000000000010'
		and staff_agent_id = '70100000-0000-4000-8000-0000000000a1') <> 'Nora Dahl' then
		raise exception 'The rename back reaches the roster'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['srace_post','srace_save','srace_hold']) name;

-- The committed fixture leaves the shared suite database.
set session_replication_role = replica;
delete from public.qorpera_folder_company_index where environment_id = '70100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_journal where environment_id = '70100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '70100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '70100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '70100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_operation_keys where environment_id = '70100000-0000-4000-8000-000000000020';
delete from public.qorpera_company_cofounders where profile_id = '70100000-0000-4000-8000-000000000010';
delete from public.qorpera_company_room_members where room_id in (select id from public.qorpera_company_rooms where profile_id = '70100000-0000-4000-8000-000000000010');
delete from public.qorpera_company_rooms where profile_id = '70100000-0000-4000-8000-000000000010';
delete from public.qorpera_shared_sessions where profile_id = '70100000-0000-4000-8000-000000000010';
delete from public.qorpera_profile_staff where profile_id = '70100000-0000-4000-8000-000000000010';
set session_replication_role = origin;
-- With triggers on, so the object mirror (qorpera_profile_objects) goes too.
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '70100000-0000-4000-8000-000000000010/%';
delete from public.qorpera_profiles where id = '70100000-0000-4000-8000-000000000010';
delete from auth.users where id in ('70100000-0000-4000-8000-000000000001','70100000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '70100000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_profile_staff where profile_id = '70100000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '70100000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '70100000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
