-- Summary trees M1a under concurrency (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.3, §10; 20260930110000): a
-- memory commit takes each conversation it names FOR SHARE at the session step (rank 11), so an erase that raises the
-- generation (FOR UPDATE on the same row) either goes first, and the batch is refused whole, or waits for it. A member
-- join, which takes the agent thread conversations FOR UPDATE at rank 11, and a memory commit wait for each other in
-- either order, without a deadlock. The fixture is committed so other connections see it, and removed at the end. Waits
-- are detected with pg_blocking_pids, never by wall-clock time.

insert into auth.users(id,email) values
	('94200000-0000-4000-8000-000000000001','memory-race-owner@example.test'),
	('94200000-0000-4000-8000-000000000002','memory-race-member@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('94200000-0000-4000-8000-000000000010','Nordlys Memory Race','94200000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('94200000-0000-4000-8000-000000000010','94200000-0000-4000-8000-000000000001','memory-race-owner@example.test','Owner','owner'),
	('94200000-0000-4000-8000-000000000010','94200000-0000-4000-8000-000000000002','memory-race-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('94200000-0000-4000-8000-000000000020','94200000-0000-4000-8000-000000000010','Environment',1,'94200000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', false) \g /dev/null
select public.qorpera_folder_enable('94200000-0000-4000-8000-000000000020') \g /dev/null
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
create function pg_temp.stage(p_text text, p_profile uuid default '94200000-0000-4000-8000-000000000010') returns jsonb language plpgsql as $$
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
		(select version from public.qorpera_folder_entries where environment_id = '94200000-0000-4000-8000-000000000020'
			and key_text = 'vision/vision.md'))
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('94200000-0000-4000-8000-000000000020', p_actor, p_units);
	return public.qorpera_folder_commit('94200000-0000-4000-8000-000000000020', p_actor, p_key, p_units);
end $$;
create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"94200000-0000-4000-8000-000000000001"}'::jsonb
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
	select version from public.qorpera_folder_entries where environment_id = '94200000-0000-4000-8000-000000000020' and key_text = p_key
$$;

-- An agent's thread conversation.
create function pg_temp.thread(p_agent uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms
	where profile_id = '94200000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_agent
$$;
create function pg_temp.toml(p_session uuid, p_bytes integer default 1024) returns text language sql as $$
	select format(E'format = 1\nconversation = "%s"\nnode_bytes = %s\n', p_session, p_bytes)
$$;
create function pg_temp.tree_file(p_path text, p_text text, p_expected uuid default null) returns jsonb language sql as $$
	select pg_temp.write(p_path, x.kind, p_text, jsonb_build_object('kind', x.kind), p_expected)
	from (select public.qorpera_structured_path_kind(public.qorpera_folder_key(p_path)) as kind) x
$$;
-- A memory commit's SQL for another connection, as the platform, naming each conversation at the generation given. Its
-- files are staged now, in this connection: staging inside the commit's own transaction would lock the company row.
create function pg_temp.sql_memory(p_key text, p_units jsonb, p_sessions uuid[], p_generations bigint[]) returns text language sql as $$
	select format('select public.qorpera_folder_memory_commit(%L, %L, %L, %L, %L)', '94200000-0000-4000-8000-000000000020',
		'{"kind":"platform"}', p_key, p_units, jsonb_build_object('sessionGenerations', (select jsonb_agg(jsonb_build_object(
			'sessionId', s.id, 'generation', s.g) order by s.o) from unnest(p_sessions, p_generations) with ordinality s(id, g, o))))
$$;
-- A tree's first change set: its root and tree.toml.
create function pg_temp.new_tree(p_agent uuid, p_handle text, p_bytes integer default 1024) returns jsonb language sql as $$
	select jsonb_build_array(jsonb_build_object('op','mkdir','path','agents/' || p_handle || '/memory/thread'),
		pg_temp.tree_file('agents/' || p_handle || '/memory/thread/tree.toml', pg_temp.toml(pg_temp.thread(p_agent), p_bytes)))
$$;

-- The creation commit and two hires, committed.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'mrace-seed-0001', jsonb_build_array(
	jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Memory Race'),
	jsonb_build_object('op','mkdir','path','agents'),
	pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
	pg_temp.hire('co-founder', '94200000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'),
	jsonb_build_object('op','mkdir','path','agents/groups'))), 6, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'mrace-hire-0001', jsonb_build_array(
	pg_temp.hire('nora', '94200000-0000-4000-8000-0000000000a1', 'Nora'), pg_temp.hire('otto', '94200000-0000-4000-8000-0000000000a2', 'Otto'))),
	2, 'saved') \g /dev/null
select set_config('qorpera_test.nora_session', pg_temp.thread('94200000-0000-4000-8000-0000000000a1')::text, false) \g /dev/null
select set_config('qorpera_test.otto_session', pg_temp.thread('94200000-0000-4000-8000-0000000000a2')::text, false) \g /dev/null
-- Nora's tree, built at generation 0 (A) and at 1 (A2); Otto's, naming both conversations (B1).
select set_config('qorpera_test.memory_a', pg_temp.sql_memory('mrace-a', pg_temp.new_tree('94200000-0000-4000-8000-0000000000a1', 'nora'),
	array[current_setting('qorpera_test.nora_session')::uuid], array[0]), false) \g /dev/null
select set_config('qorpera_test.memory_a2', pg_temp.sql_memory('mrace-a2', pg_temp.new_tree('94200000-0000-4000-8000-0000000000a1', 'nora', 512),
	array[current_setting('qorpera_test.nora_session')::uuid], array[1]), false) \g /dev/null
select set_config('qorpera_test.memory_b1', pg_temp.sql_memory('mrace-b1', pg_temp.new_tree('94200000-0000-4000-8000-0000000000a2', 'otto'),
	array[current_setting('qorpera_test.nora_session')::uuid, current_setting('qorpera_test.otto_session')::uuid], array[1, 0]), false) \g /dev/null
do $$
begin
	if current_setting('qorpera_test.nora_session', true) is null or current_setting('qorpera_test.otto_session', true) is null
		or (select count(*) from public.qorpera_shared_sessions where id in (current_setting('qorpera_test.nora_session')::uuid,
			current_setting('qorpera_test.otto_session')::uuid) and memory_generation = 0) <> 2 then
		raise exception 'Each hire has a thread conversation at generation 0'; end if;
end $$;

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['mrace_post','mrace_save','mrace_hold']) name;
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"service_role"}'$q$) from unnest(array['mrace_post','mrace_save','mrace_hold']) name;
select set_config('qorpera_test.pid_' || name, pid::text, false)
from unnest(array['mrace_post','mrace_save','mrace_hold']) name, lateral dblink(name, 'select pg_backend_pid()') as t(pid integer);

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

-- A. An erase holds Nora's conversation and raises its generation. A batch built before it waits at the session step,
-- then reads the raised generation and is refused whole: the root too, which names no generation of its own.
do $$
declare v jsonb; ns uuid := current_setting('qorpera_test.nora_session')::uuid;
begin
	perform dblink_exec('mrace_hold', 'begin');
	perform dblink_exec('mrace_hold', format('update public.qorpera_shared_sessions set memory_generation = memory_generation + 1 where id = %L', ns));
	perform dblink_send_query('mrace_save', current_setting('qorpera_test.memory_a'));
	if not pg_temp.waits_for('mrace_save', 'mrace_hold') then raise exception 'The batch must wait for the erase at the conversation'; end if;
	perform dblink_exec('mrace_hold', 'commit');
	select r into v from dblink_get_result('mrace_save') as t(r jsonb);
	perform * from dblink_get_result('mrace_save') as t(r jsonb);
	perform pg_temp.expect(v, 1, 'refused', 'memory_generation_stale');
	perform pg_temp.expect(v, 2, 'refused', 'memory_generation_stale');
	if pg_temp.version('agents/nora/memory/thread') is not null
		or exists (select 1 from public.qorpera_memory_trees where environment_id = '94200000-0000-4000-8000-000000000020') then
		raise exception 'A refused batch writes nothing'; end if;
end $$;

-- A2. An erase that rolls back leaves the generation as it was: the batch that waited for it saves.
do $$
declare v jsonb; ns uuid := current_setting('qorpera_test.nora_session')::uuid;
begin
	perform dblink_exec('mrace_hold', 'begin');
	perform dblink_exec('mrace_hold', format('update public.qorpera_shared_sessions set memory_generation = memory_generation + 1 where id = %L', ns));
	perform dblink_send_query('mrace_save', current_setting('qorpera_test.memory_a2'));
	if not pg_temp.waits_for('mrace_save', 'mrace_hold') then raise exception 'The batch must wait for the erase at the conversation'; end if;
	perform dblink_exec('mrace_hold', 'rollback');
	select r into v from dblink_get_result('mrace_save') as t(r jsonb);
	perform * from dblink_get_result('mrace_save') as t(r jsonb);
	perform pg_temp.expect(v, 1, 'saved');
	perform pg_temp.expect(v, 2, 'saved');
	if (select memory_generation from public.qorpera_shared_sessions where id = ns) is distinct from 1
		or (select node_bytes from public.qorpera_memory_trees where session_id = ns and retired_at is null) is distinct from 512 then
		raise exception 'The batch saves at generation 1'; end if;
end $$;

-- B1. A join holds the thread conversations FOR UPDATE; a batch naming two of them waits at the session step, and
-- saves once the join is gone.
do $$
declare v jsonb;
begin
	perform dblink_exec('mrace_post', 'begin');
	perform * from dblink('mrace_post', $q$select public.qorpera_folder_member_change_enter('94200000-0000-4000-8000-000000000010',
		'94200000-0000-4000-8000-000000000002', 'join')::text$q$) as t(x text);
	perform dblink_send_query('mrace_save', current_setting('qorpera_test.memory_b1'));
	if not pg_temp.waits_for('mrace_save', 'mrace_post') then raise exception 'The batch must wait for the join at the conversations'; end if;
	perform dblink_exec('mrace_post', 'rollback');
	select r into v from dblink_get_result('mrace_save') as t(r jsonb);
	perform * from dblink_get_result('mrace_save') as t(r jsonb);
	perform pg_temp.expect(v, 1, 'saved');
	perform pg_temp.expect(v, 2, 'saved');
end $$;

-- B2. The other order: the batch holds both conversations FOR SHARE (it waits on a path another connection holds) and
-- a join starts. The join waits for the batch at the conversations, and both finish.
select set_config('qorpera_test.memory_b2', pg_temp.sql_memory('mrace-b2', jsonb_build_array(
	pg_temp.tree_file('agents/otto/memory/thread/tree.toml', pg_temp.toml(current_setting('qorpera_test.otto_session')::uuid, 256),
		pg_temp.version('agents/otto/memory/thread/tree.toml'))),
	array[current_setting('qorpera_test.nora_session')::uuid, current_setting('qorpera_test.otto_session')::uuid], array[1, 0]), false) \g /dev/null
do $$
declare v jsonb;
begin
	perform dblink_exec('mrace_hold', 'begin');
	perform * from dblink('mrace_hold', $q$select 1 from public.qorpera_folder_entries
		where environment_id = '94200000-0000-4000-8000-000000000020' and key_text = 'agents/otto/memory/thread/tree.toml' for update$q$)
		as t(x integer);
	perform dblink_send_query('mrace_save', current_setting('qorpera_test.memory_b2'));
	if not pg_temp.waits_for('mrace_save', 'mrace_hold') then raise exception 'The batch must wait on the held path'; end if;
	perform dblink_exec('mrace_post', 'begin');
	perform dblink_send_query('mrace_post', $q$select public.qorpera_folder_member_change_enter('94200000-0000-4000-8000-000000000010',
		'94200000-0000-4000-8000-000000000002', 'join')::text$q$);
	if not pg_temp.waits_for('mrace_post', 'mrace_save') then raise exception 'The join must wait for the batch at the conversations'; end if;
	perform dblink_exec('mrace_hold', 'rollback');
	select r into v from dblink_get_result('mrace_save') as t(r jsonb);
	perform * from dblink_get_result('mrace_save') as t(r jsonb);
	perform pg_temp.expect(v, 1, 'saved');
	perform * from dblink_get_result('mrace_post') as t(x text);
	perform * from dblink_get_result('mrace_post') as t(x text);
	perform dblink_exec('mrace_post', 'rollback');
	if (select node_bytes from public.qorpera_memory_trees where session_id = current_setting('qorpera_test.otto_session')::uuid
		and retired_at is null) is distinct from 256 then
		raise exception 'The batch saves before the join'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['mrace_post','mrace_save','mrace_hold']) name;

-- The committed fixture leaves the shared suite database.
set session_replication_role = replica;
delete from public.qorpera_memory_tree_nodes where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_memory_trees where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_memory_read_receipts where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_company_index where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_journal where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_operation_keys where environment_id = '94200000-0000-4000-8000-000000000020';
delete from public.qorpera_company_cofounders where profile_id = '94200000-0000-4000-8000-000000000010';
delete from public.qorpera_company_room_members where room_id in (select id from public.qorpera_company_rooms where profile_id = '94200000-0000-4000-8000-000000000010');
delete from public.qorpera_company_rooms where profile_id = '94200000-0000-4000-8000-000000000010';
delete from public.qorpera_session_events where session_id in (select id from public.qorpera_shared_sessions where profile_id = '94200000-0000-4000-8000-000000000010');
delete from public.qorpera_shared_sessions where profile_id = '94200000-0000-4000-8000-000000000010';
delete from public.qorpera_profile_staff where profile_id = '94200000-0000-4000-8000-000000000010';
set session_replication_role = origin;
-- With triggers on: version-2 objects are catalog rows of the object gateway (no Storage mirror), so they go by
-- hand, with their proofs and chunk rows; any Storage object takes its mirror row with it.
delete from public.qorpera_profile_objects where profile_id = '94200000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '94200000-0000-4000-8000-000000000010/%';
delete from public.qorpera_profiles where id = '94200000-0000-4000-8000-000000000010';
delete from auth.users where id in ('94200000-0000-4000-8000-000000000001','94200000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '94200000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_profile_staff where profile_id = '94200000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_memory_trees where environment_id = '94200000-0000-4000-8000-000000000020')
		or exists (select 1 from storage.objects where name like '94200000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '94200000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '94200000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '94200000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
