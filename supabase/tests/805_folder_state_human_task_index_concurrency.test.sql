-- Company state files, H2b under concurrency (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (H2)" §6). The
-- rank-5 row locks on the task and contact index rows make the rules read what the other change set wrote: a proof unit
-- waits for the person's done and then meets a conflict; a contact's delete waits for a new task naming it and is then
-- refused. Without the locks both would read the old row and save. The fixture is committed so other connections see it,
-- and removed at the end. Waits are detected with pg_blocking_pids, never by wall-clock time.

insert into auth.users(id,email) values
	('80500000-0000-4000-8000-000000000001','h2-race-owner@example.test'),
	('80500000-0000-4000-8000-000000000002','h2-race-member@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('80500000-0000-4000-8000-000000000010','Nordlys Task Race','80500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('80500000-0000-4000-8000-000000000010','80500000-0000-4000-8000-000000000001','h2-race-owner@example.test','Owner','owner'),
	('80500000-0000-4000-8000-000000000010','80500000-0000-4000-8000-000000000002','h2-race-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('80500000-0000-4000-8000-000000000020','80500000-0000-4000-8000-000000000010','Environment',1,'80500000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', false) \g /dev/null
select public.qorpera_folder_enable('80500000-0000-4000-8000-000000000020') \g /dev/null
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
create function pg_temp.stage(p_text text, p_profile uuid default '80500000-0000-4000-8000-000000000010') returns jsonb language plpgsql as $$
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
		(select version from public.qorpera_folder_entries where environment_id = '80500000-0000-4000-8000-000000000020'
			and key_text = 'vision/vision.md'))
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('80500000-0000-4000-8000-000000000020', p_actor, p_units);
	return public.qorpera_folder_commit('80500000-0000-4000-8000-000000000020', p_actor, p_key, p_units);
end $$;
create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"80500000-0000-4000-8000-000000000001"}'::jsonb
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
	select version from public.qorpera_folder_entries where environment_id = '80500000-0000-4000-8000-000000000020' and key_text = p_key
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '80500000-0000-4000-8000-000000000020'
$$;
create function pg_temp.staff(p_id uuid) returns public.qorpera_profile_staff language sql as $$
	select * from public.qorpera_profile_staff where profile_id = '80500000-0000-4000-8000-000000000010' and staff_agent_id = p_id
$$;


create function pg_temp.mem() returns jsonb language sql as $$
	select '{"kind":"member","userId":"80500000-0000-4000-8000-000000000002"}'::jsonb
$$;
-- A task file's text and parse (the database reads only the parse and the text's hash).
create function pg_temp.task_parse(p_id uuid, p_set jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('kind','human-task','id',p_id,'title','Fit the disk','status','open',
		'member','80500000-0000-4000-8000-000000000002','contact',null,'from','80500000-0000-4000-8000-0000000000a1','todo',null,
		'due','2099-10-20T12:00:00Z','minutes',null,'proof','["photo"]'::jsonb,'files','[]'::jsonb,'reason',null,'secret',null,
		'secretState',null,'connection',null,'step',null,'instructions','Fit it.','steps','[]'::jsonb) || p_set
$$;
create function pg_temp.save(p_path text, p_parse jsonb) returns jsonb language sql as $$
	select pg_temp.write(p_path, p_parse ->> 'kind', 'x ' || md5(p_parse::text), p_parse, pg_temp.version(p_path))
$$;
create function pg_temp.contact_parse() returns jsonb language sql as $$
	select jsonb_build_object('kind','contact','id','80500000-0000-4000-8000-0000000000f1','name','Maria Jensen','organization',null,
		'email','maria@example.test','phone',null,'asks','[]'::jsonb,'notes','')
$$;
create function pg_temp.put(p_path text, p_text text) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text))
$$;

-- The company, the asking agent Nora, a task for the member with its proof folder, and a contact; committed.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'race-seed-0001', jsonb_build_array(
	jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Task Race'),
	jsonb_build_object('op','mkdir','path','agents'),
	pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
	pg_temp.hire('co-founder', '80500000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'))), 5, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'race-hire-0001', jsonb_build_array(
	pg_temp.hire('nora', '80500000-0000-4000-8000-0000000000a1', 'Nora'))), 1, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'race-tasks-0001', jsonb_build_array(
	jsonb_build_object('op','mkdir','path','human-tasks'), jsonb_build_object('op','mkdir','path','contacts'),
	pg_temp.save('contacts/maria.md', pg_temp.contact_parse()),
	pg_temp.save('human-tasks/fit.md', pg_temp.task_parse('80500000-0000-4000-8000-0000000000e1')))), 4, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.commit(pg_temp.mem(), 'race-proof-0001', jsonb_build_array(
	jsonb_build_object('op','mkdir','path','human-tasks/fit'), jsonb_build_object('op','mkdir','path','human-tasks/fit/proof'),
	pg_temp.put('human-tasks/fit/proof/photo-1.jpg', 'a photo'))), 3, 'saved') \g /dev/null
-- The change sets, staged now: staging inside a change set's own transaction would take other locks first.
select set_config('qorpera_test.h2_done', pg_temp.sql_commit('80500000-0000-4000-8000-000000000020', pg_temp.mem()::text, 'race-done-0001',
	jsonb_build_array(pg_temp.save('human-tasks/fit.md', pg_temp.task_parse('80500000-0000-4000-8000-0000000000e1', '{"status":"done"}')))::text), false) \g /dev/null
select set_config('qorpera_test.h2_proof', pg_temp.sql_commit('80500000-0000-4000-8000-000000000020', pg_temp.mem()::text, 'race-proof-0002',
	jsonb_build_array(pg_temp.put('human-tasks/fit/proof/photo-2.jpg', 'another'))::text), false) \g /dev/null
select set_config('qorpera_test.h2_task', pg_temp.sql_commit('80500000-0000-4000-8000-000000000020', pg_temp.owner()::text, 'race-task-0002',
	jsonb_build_array(pg_temp.save('human-tasks/vat.md', pg_temp.task_parse('80500000-0000-4000-8000-0000000000e2',
		'{"member":null,"contact":"80500000-0000-4000-8000-0000000000f1","proof":["file"]}')))::text), false) \g /dev/null
select set_config('qorpera_test.h2_forget', pg_temp.sql_commit('80500000-0000-4000-8000-000000000020', pg_temp.owner()::text, 'race-forget-0001',
	jsonb_build_array(jsonb_build_object('op','delete','path','contacts/maria.md','expectedVersion',pg_temp.version('contacts/maria.md'),
		'asOfSeq',pg_temp.seq()))::text), false) \g /dev/null

select dblink_connect(name, 'dbname=qorpera_test') from unnest(array['h2race_a','h2race_b']) name;
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"service_role"}'$q$) from unnest(array['h2race_a','h2race_b']) name;
select set_config('qorpera_test.pid_' || name, pid::text, false)
from unnest(array['h2race_a','h2race_b']) name, lateral dblink(name, 'select pg_backend_pid()') as t(pid integer);

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
-- One change set held open in A while B runs, then A commits and B's answer is read.
create function pg_temp.race(p_a text, p_b text) returns jsonb language plpgsql as $$
declare a jsonb; b jsonb;
begin
	perform dblink_exec('h2race_a', 'begin');
	select r into a from dblink('h2race_a', current_setting(p_a)) as t(r jsonb);
	if a -> 'units' -> 0 ->> 'outcome' is distinct from 'saved' then raise exception 'The first change set saves: %', a; end if;
	perform dblink_send_query('h2race_b', current_setting(p_b));
	if not pg_temp.waits_for('h2race_b', 'h2race_a') then raise exception 'The second change set waits for the first'; end if;
	perform dblink_exec('h2race_a', 'commit');
	select r into b from dblink_get_result('h2race_b') as t(r jsonb);
	perform * from dblink_get_result('h2race_b') as t(r jsonb);
	return b;
end $$;

-- A. The person's done holds the task's row; a proof unit in the task's folder waits for it, then reads the done and meets
-- a conflict: nothing lands in a done task's folder unseen.
do $$
declare b jsonb := pg_temp.race('qorpera_test.h2_done', 'qorpera_test.h2_proof');
begin
	if b -> 'units' -> 0 ->> 'outcome' is distinct from 'conflict' or b -> 'units' -> 0 ->> 'reason' is distinct from 'version_changed' then
		raise exception 'A proof unit behind the done is a conflict: %', b; end if;
end $$;

-- B. A new task naming a contact holds the contact's row; the contact's delete waits for it, then sees the task and is
-- refused: a contact a task names stays.
do $$
declare b jsonb := pg_temp.race('qorpera_test.h2_task', 'qorpera_test.h2_forget');
begin
	if b -> 'units' -> 0 ->> 'outcome' is distinct from 'refused'
		or coalesce(b -> 'units' -> 0 -> 'problems' -> 0 ->> 'message', '') not like 'a contact named by a task that is not final stays%' then
		raise exception 'The contact''s delete behind the task is refused: %', b; end if;
end $$;

select dblink_disconnect(name) from unnest(array['h2race_a','h2race_b']) name;

-- The committed fixture leaves the shared suite database.
set session_replication_role = replica;
delete from public.qorpera_folder_human_task_index where environment_id = '80500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_contact_index where environment_id = '80500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_company_index where environment_id = '80500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_journal where environment_id = '80500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '80500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '80500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '80500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_operation_keys where environment_id = '80500000-0000-4000-8000-000000000020';
delete from public.qorpera_company_cofounders where profile_id = '80500000-0000-4000-8000-000000000010';
delete from public.qorpera_company_room_members where room_id in (select id from public.qorpera_company_rooms where profile_id = '80500000-0000-4000-8000-000000000010');
delete from public.qorpera_company_rooms where profile_id = '80500000-0000-4000-8000-000000000010';
delete from public.qorpera_shared_sessions where profile_id = '80500000-0000-4000-8000-000000000010';
delete from public.qorpera_profile_staff where profile_id = '80500000-0000-4000-8000-000000000010';
set session_replication_role = origin;
-- With triggers on: version-2 objects are catalog rows of the object gateway (no Storage mirror), so they go by
-- hand, with their proofs and chunk rows; any Storage object takes its mirror row with it.
delete from public.qorpera_profile_objects where profile_id = '80500000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '80500000-0000-4000-8000-000000000010/%';
delete from public.qorpera_profiles where id = '80500000-0000-4000-8000-000000000010';
delete from auth.users where id in ('80500000-0000-4000-8000-000000000001','80500000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '80500000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_profile_staff where profile_id = '80500000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '80500000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '80500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '80500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '80500000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
