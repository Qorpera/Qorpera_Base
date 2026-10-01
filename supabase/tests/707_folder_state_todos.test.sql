-- Company state files, F2-5a (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2, §4): todos on the folder core.
-- A todo file is a row of the runtime's todo table, owned by the agent whose folder holds it; today's rules hold (done
-- waits for working workers, closed stays closed, a changed requested_by is a member, a todo with a working worker
-- stays put); deleting cancels and frees the name; a hire may bring its first todo.
begin;

insert into auth.users(id,email) values
	('70700000-0000-4000-8000-000000000001','todos-owner@example.test'),
	('70700000-0000-4000-8000-000000000002','todos-member@example.test'),
	('70700000-0000-4000-8000-000000000003','todos-stranger@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values ('70700000-0000-4000-8000-000000000010','Nordlys Todos','70700000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('70700000-0000-4000-8000-000000000010','70700000-0000-4000-8000-000000000001','todos-owner@example.test','Owner','owner'),
	('70700000-0000-4000-8000-000000000010','70700000-0000-4000-8000-000000000002','todos-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('70700000-0000-4000-8000-000000000020','70700000-0000-4000-8000-000000000010','Environment',1,'70700000-0000-4000-8000-000000000001'), ('70700000-0000-4000-8000-000000000022','70700000-0000-4000-8000-000000000010','Other environment',1,'70700000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('70700000-0000-4000-8000-000000000020') \g /dev/null
-- Verified bytes for a text, as the object gateway leaves them.
create function pg_temp.stage(p_text text, p_profile uuid default '70700000-0000-4000-8000-000000000010')
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
		(select version from public.qorpera_folder_entries where environment_id = '70700000-0000-4000-8000-000000000020'
			and key_text = 'vision/vision.md'))
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_commit('70700000-0000-4000-8000-000000000020', p_actor, p_key, p_units)
$$;
create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"70700000-0000-4000-8000-000000000001"}'::jsonb
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
	select version from public.qorpera_folder_entries where environment_id = '70700000-0000-4000-8000-000000000020' and key_text = p_key
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '70700000-0000-4000-8000-000000000020'
$$;
create function pg_temp.staff(p_id uuid) returns public.qorpera_profile_staff language sql as $$
	select * from public.qorpera_profile_staff where profile_id = '70700000-0000-4000-8000-000000000010' and staff_agent_id = p_id
$$;

create function pg_temp.todo_text(p_id uuid, p_title text, p_status text, p_requested uuid, p_detail text) returns text language sql as $$
	select format(E'---\nid: %s\ntitle: %s\nstatus: %s\n%s---\n%s\n', p_id, p_title, p_status,
		case when p_requested is null then '' else format(E'requested_by: %s\n', p_requested) end, p_detail)
$$;
create function pg_temp.todo_parse(p_id uuid, p_title text, p_status text, p_requested uuid, p_detail text) returns jsonb language sql as $$
	select jsonb_build_object('kind','todo','id',p_id,'title',p_title,'status',p_status,'requestedBy',p_requested,'detail',p_detail)
$$;
create function pg_temp.todo(p_path text, p_id uuid, p_title text, p_status text default 'open', p_requested uuid default null,
	p_detail text default '') returns jsonb language sql as $$
	select pg_temp.write(p_path, 'todo', pg_temp.todo_text(p_id, p_title, p_status, p_requested, p_detail),
		pg_temp.todo_parse(p_id, p_title, p_status, p_requested, p_detail), pg_temp.version(p_path))
$$;
create function pg_temp.mem() returns jsonb language sql as $$
	select '{"kind":"member","userId":"70700000-0000-4000-8000-000000000002"}'::jsonb
$$;
create function pg_temp.row(p_id uuid) returns public.qorpera_runtime_agent_todos language sql as $$
	select * from public.qorpera_runtime_agent_todos where id = p_id
$$;
create function pg_temp.refused(p_result jsonb, p_reason text default 'structured_rule') returns boolean language sql as $$
	select coalesce(p_result -> 'units' -> 0 ->> 'outcome' = 'refused' and p_result -> 'units' -> 0 ->> 'reason' = p_reason, false)
$$;
create function pg_temp.move(p_from text, p_to text) returns jsonb language sql as $$
	select jsonb_build_object('op','move','from',p_from,'to',p_to,'expectedVersion',pg_temp.version(p_from),'asOfSeq',pg_temp.seq())
$$;
-- A working worker for a todo (its runs are not needed here, so foreign keys are off for the insert).
create function pg_temp.working(p_todo uuid, p_staff uuid) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_workers(profile_id, environment_id, staff_agent_id, todo_id, worker_key, title, access, revival,
		dispatch, requested_by_user_id, steering_run_id)
	values ('70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000020', p_staff, p_todo, 'w-' || left(p_todo::text, 8), 'Work', 'read', 'each', '{}', '70700000-0000-4000-8000-000000000001', extensions.gen_random_uuid());
	set local session_replication_role = origin;
end $$;
create function pg_temp.stop_working(p_todo uuid) returns void language sql as $$
	delete from public.qorpera_runtime_workers where todo_id = p_todo
$$;

create function pg_temp.hire_todos(p_handle text, p_id uuid, p_todos jsonb) returns jsonb language sql as $$
	-- A hire with its todos: p_todos is [[name, id, title], ...].
	select jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(jsonb_build_object('path','todos','kind','folder'),
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_handle))))
			|| coalesce((select jsonb_agg(jsonb_build_object('path','todos/' || (t ->> 0) || '.md','kind','file',
				'file',pg_temp.stage(pg_temp.todo_text((t ->> 1)::uuid, t ->> 2, 'open', null, '')))) from jsonb_array_elements(p_todos) t), '[]'),
		'structured', jsonb_build_array(pg_temp.entry('agents/' || p_handle || '/agent.md', 'agent', pg_temp.agent_text(p_id, p_handle),
				pg_temp.agent_parse(p_id, p_handle)))
			|| coalesce((select jsonb_agg(pg_temp.entry('agents/' || p_handle || '/todos/' || (t ->> 0) || '.md', 'todo',
				pg_temp.todo_text((t ->> 1)::uuid, t ->> 2, 'open', null, ''), pg_temp.todo_parse((t ->> 1)::uuid, t ->> 2, 'open', null, '')))
				from jsonb_array_elements(p_todos) t), '[]'))
$$;

-- 1. The company, two agents, and a todo -------------------------------------------------------------------------------

do $$
declare r jsonb; i integer; x public.qorpera_runtime_agent_todos; t jsonb;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Todos'),
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', '70700000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder')));
	for i in 1..5 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit(pg_temp.owner(), 'hire-0001', jsonb_build_array(pg_temp.hire('nora', '70700000-0000-4000-8000-0000000000a1', 'Nora'), pg_temp.hire('otto', '70700000-0000-4000-8000-0000000000a2', 'Otto')));
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	-- A todo save takes the company row at rank 0 (C1b-3a moved it from rank 2).
	select coalesce(jsonb_agg(to_jsonb(y)), '[]'::jsonb) into t from public.qorpera_folder_structured_targets('70700000-0000-4000-8000-000000000020', pg_temp.owner(),
		jsonb_build_array(pg_temp.todo('agents/nora/todos/call-clinic.md', '70700000-0000-4000-8000-0000000000d1', 'Call the clinic'))) y;
	if t is distinct from '[{"rank":0,"tbl":"qorpera_profiles","key":"70700000-0000-4000-8000-000000000010","mode":"keyshare"}]' then
		raise exception 'A todo save locks the company row only: %', t; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'todo-0001', jsonb_build_array(
		pg_temp.todo('agents/nora/todos/call-clinic.md', '70700000-0000-4000-8000-0000000000d1', 'Call the clinic', 'open', '70700000-0000-4000-8000-000000000002', 'Ask about times.'))), 1, 'saved');
	x := pg_temp.row('70700000-0000-4000-8000-0000000000d1');
	if x.id is null or x.staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a1' or x.todo_key is distinct from 'call-clinic' or x.title is distinct from 'Call the clinic'
		or x.detail is distinct from 'Ask about times.' or x.state is distinct from 'open' or x.requested_by_user_id is distinct from '70700000-0000-4000-8000-000000000002'
		or x.created_by_run_id is not null or x.folder_path is distinct from 'agents/nora/todos/call-clinic.md'
		or x.folder_path_version is distinct from pg_temp.version('agents/nora/todos/call-clinic.md') or x.revision is distinct from 1::bigint then
		raise exception 'A todo file is a todo of the agent whose folder holds it: %', to_jsonb(x); end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.mem(), 'todo-0002', jsonb_build_array(
		pg_temp.todo('agents/nora/todos/call-clinic.md', '70700000-0000-4000-8000-0000000000d1', 'Call the clinic', 'blocked', '70700000-0000-4000-8000-000000000002', 'Ask about times. No answer.'))), 1, 'saved');
	x := pg_temp.row('70700000-0000-4000-8000-0000000000d1');
	if x.state is distinct from 'blocked' or x.detail is distinct from 'Ask about times. No answer.' or x.revision is distinct from 2::bigint then
		raise exception 'An edit reaches the todo: %', to_jsonb(x); end if;
	if public.qorpera_folder_structured_review_class('70700000-0000-4000-8000-000000000020', jsonb_build_object('kind','staff_agent','requesterUserId','70700000-0000-4000-8000-000000000002'),
		pg_temp.todo('agents/nora/todos/call-clinic.md', '70700000-0000-4000-8000-0000000000d1', 'Call'), 'agents/nora/todos/call-clinic.md', null) is distinct from 'plain' then
		raise exception 'A todo file is not reviewed'; end if;
end $$;

-- 2. A hire may bring its first todo ------------------------------------------------------------------------------------

do $$
declare r jsonb;
begin
	r := pg_temp.commit(pg_temp.owner(), 'hire-0002', jsonb_build_array(jsonb_build_object('op','new_folder','path','agents/vera',
		'contents', jsonb_build_array(
			jsonb_build_object('path','todos','kind','folder'),
			jsonb_build_object('path','todos/first.md','kind','file','file',pg_temp.stage(pg_temp.todo_text('70700000-0000-4000-8000-0000000000d6', 'Say hello', 'open', null, ''))),
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text('70700000-0000-4000-8000-0000000000a3', 'Vera')))),
		'structured', jsonb_build_array(
			pg_temp.entry('agents/vera/todos/first.md', 'todo', pg_temp.todo_text('70700000-0000-4000-8000-0000000000d6', 'Say hello', 'open', null, ''),
				pg_temp.todo_parse('70700000-0000-4000-8000-0000000000d6', 'Say hello', 'open', null, '')),
			pg_temp.entry('agents/vera/agent.md', 'agent', pg_temp.agent_text('70700000-0000-4000-8000-0000000000a3', 'Vera'), pg_temp.agent_parse('70700000-0000-4000-8000-0000000000a3', 'Vera'))))));
	perform pg_temp.expect(r, 1, 'saved');
	if (pg_temp.row('70700000-0000-4000-8000-0000000000d6')).staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a3' or (pg_temp.row('70700000-0000-4000-8000-0000000000d6')).requested_by_user_id is not null then
		raise exception 'The hire''s first todo is the new agent''s own: %', to_jsonb(pg_temp.row('70700000-0000-4000-8000-0000000000d6')); end if;
end $$;

-- 3. The rules ---------------------------------------------------------------------------------------------------------

do $$
declare r jsonb;
begin
	-- A todo lives next to an agent.md.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'ghost-0001', jsonb_build_array(jsonb_build_object('op','new_folder',
		'path','agents/ghost','contents',jsonb_build_array(jsonb_build_object('path','todos','kind','folder'))))), 1, 'saved');
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0001', jsonb_build_array(
		pg_temp.todo('agents/ghost/todos/boo.md', '70700000-0000-4000-8000-0000000000d2', 'Boo')))) then
		raise exception 'A todo needs an agent'; end if;
	-- The id never changes, and belongs to one file.
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0002', jsonb_build_array(
		pg_temp.todo('agents/nora/todos/call-clinic.md', '70700000-0000-4000-8000-0000000000d2', 'Call the clinic', 'blocked', '70700000-0000-4000-8000-000000000002')))) then
		raise exception 'A todo''s id never changes'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0003', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/twin.md', '70700000-0000-4000-8000-0000000000d1', 'Twin')))) then
		raise exception 'One file per todo'; end if;
	-- A changed requested_by is a member; an unchanged one is not checked again.
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0004', jsonb_build_array(
		pg_temp.todo('agents/nora/todos/call-clinic.md', '70700000-0000-4000-8000-0000000000d1', 'Call the clinic', 'blocked', '70700000-0000-4000-8000-000000000003')))) then
		raise exception 'requested_by is a member'; end if;
	delete from public.qorpera_profile_members where profile_id = '70700000-0000-4000-8000-000000000010' and user_id = '70700000-0000-4000-8000-000000000002';
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'rule-0005', jsonb_build_array(
		pg_temp.todo('agents/nora/todos/call-clinic.md', '70700000-0000-4000-8000-0000000000d1', 'Call the clinic today', 'blocked', '70700000-0000-4000-8000-000000000002'))), 1, 'saved');
	-- done waits for a working worker; a closed todo is not opened again.
	perform pg_temp.working('70700000-0000-4000-8000-0000000000d1', '70700000-0000-4000-8000-0000000000a1');
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0006', jsonb_build_array(
		pg_temp.todo('agents/nora/todos/call-clinic.md', '70700000-0000-4000-8000-0000000000d1', 'Call the clinic today', 'done', '70700000-0000-4000-8000-000000000002')))) then
		raise exception 'done waits for a working worker'; end if;
	-- A todo with a working worker stays where it is.
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0007', jsonb_build_array(
		pg_temp.move('agents/nora/todos/call-clinic.md', 'agents/nora/todos/call.md')))) then
		raise exception 'A todo with a working worker is not moved'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0008', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/nora','expectedVersion',pg_temp.version('agents/nora'),'asOfSeq',pg_temp.seq())))) then
		raise exception 'An agent whose todo has a working worker is not deleted'; end if;
	perform pg_temp.stop_working('70700000-0000-4000-8000-0000000000d1');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'rule-0009', jsonb_build_array(
		pg_temp.todo('agents/nora/todos/call-clinic.md', '70700000-0000-4000-8000-0000000000d1', 'Call the clinic today', 'done', '70700000-0000-4000-8000-000000000002'))), 1, 'saved');
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0010', jsonb_build_array(
		pg_temp.todo('agents/nora/todos/call-clinic.md', '70700000-0000-4000-8000-0000000000d1', 'Call the clinic today', 'open', '70700000-0000-4000-8000-000000000002')))) then
		raise exception 'A closed todo is not opened again'; end if;
	-- The shape: a title past 200 bytes is not a todo.
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0011', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/long.md', '70700000-0000-4000-8000-0000000000d2', repeat('t', 201)))), 'structured_invalid') then
		raise exception 'A title is 1-200 bytes'; end if;
end $$;

-- 4. Moving: a new name, a new agent, an agent's rename --------------------------------------------------------------------

do $$
declare x public.qorpera_runtime_agent_todos;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'move-0001', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/write-report.md', '70700000-0000-4000-8000-0000000000d3', 'Write the report'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'move-0002', jsonb_build_array(
		pg_temp.move('agents/otto/todos/write-report.md', 'agents/nora/todos/report.md'))), 1, 'saved');
	x := pg_temp.row('70700000-0000-4000-8000-0000000000d3');
	if x.staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a1' or x.todo_key is distinct from 'report' or x.folder_path is distinct from 'agents/nora/todos/report.md' then
		raise exception 'A moved todo has its new name and agent: %', to_jsonb(x); end if;
	-- Only into an agent's todos folder.
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'move-0003', jsonb_build_array(
		pg_temp.move('agents/nora/todos/report.md', 'agents/ghost/todos/report.md')))) then
		raise exception 'A todo moves only to an agent'; end if;
	-- An agent's rename carries its todos, which keep their agent.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'move-0004', jsonb_build_array(pg_temp.move('agents/nora', 'agents/nora-dahl'))), 1, 'saved');
	x := pg_temp.row('70700000-0000-4000-8000-0000000000d3');
	if x.staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a1' or x.folder_path is distinct from 'agents/nora-dahl/todos/report.md'
		or x.folder_path_version is distinct from pg_temp.version('agents/nora-dahl/todos/report.md') then
		raise exception 'A renamed agent keeps its todos: %', to_jsonb(x); end if;
end $$;

-- 5. Deleting cancels and frees the name; a restore brings the todo back ----------------------------------------------------

do $$
declare x public.qorpera_runtime_agent_todos;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'del-0001', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/plan.md', '70700000-0000-4000-8000-0000000000d4', 'Plan the week'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'del-0002', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/otto/todos/plan.md','expectedVersion',pg_temp.version('agents/otto/todos/plan.md')))), 1, 'saved');
	x := pg_temp.row('70700000-0000-4000-8000-0000000000d4');
	if x.folder_retired_at is null or x.state is distinct from 'cancelled' or x.todo_key not like 'plan.%' then
		raise exception 'Deleting a todo cancels it and frees its name: %', to_jsonb(x); end if;
	if (pg_temp.row('70700000-0000-4000-8000-0000000000d3')).state is distinct from 'open' or (pg_temp.row('70700000-0000-4000-8000-0000000000d3')).folder_retired_at is not null then
		raise exception 'Deleting one todo leaves the others'; end if;
	-- A new todo of that name.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'del-0003', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/plan.md', '70700000-0000-4000-8000-0000000000d5', 'Plan the month'))), 1, 'saved');
	-- And the old one restored under another name.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'del-0004', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/plan-week.md', '70700000-0000-4000-8000-0000000000d4', 'Plan the week'))), 1, 'saved');
	x := pg_temp.row('70700000-0000-4000-8000-0000000000d4');
	if x.folder_retired_at is not null or x.state is distinct from 'open' or x.todo_key is distinct from 'plan-week' then
		raise exception 'A restore brings the todo back: %', to_jsonb(x); end if;
end $$;

-- 6. Review round 1: tombstones never meet, the owner is a file the unit writes, a restore is compared with the last file

do $$
declare r jsonb; x public.qorpera_runtime_agent_todos;
begin
	-- The same name deleted twice: two tombstones.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tomb-0001', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/sync.md', '70700000-0000-4000-8000-0000000000d7', 'Sync one'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tomb-0002', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/otto/todos/sync.md','expectedVersion',pg_temp.version('agents/otto/todos/sync.md')))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tomb-0003', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/sync.md', '70700000-0000-4000-8000-0000000000d8', 'Sync two'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tomb-0004', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/otto/todos/sync.md','expectedVersion',pg_temp.version('agents/otto/todos/sync.md')))), 1, 'saved');
	if (pg_temp.row('70700000-0000-4000-8000-0000000000d7')).todo_key = (pg_temp.row('70700000-0000-4000-8000-0000000000d8')).todo_key then raise exception 'Two tombstones never meet'; end if;
	-- A unit that names an agent.md it does not write gives its todo no owner.
	r := pg_temp.commit(pg_temp.owner(), 'owner-0001', jsonb_build_array(jsonb_build_object('op','new_folder','path','agents/wendy',
		'contents', jsonb_build_array(jsonb_build_object('path','todos','kind','folder'),
			jsonb_build_object('path','todos/first.md','kind','file','file',pg_temp.stage(pg_temp.todo_text('70700000-0000-4000-8000-0000000000d9', 'Hello', 'open', null, '')))),
		'structured', jsonb_build_array(
			pg_temp.entry('agents/wendy/todos/first.md', 'todo', pg_temp.todo_text('70700000-0000-4000-8000-0000000000d9', 'Hello', 'open', null, ''),
				pg_temp.todo_parse('70700000-0000-4000-8000-0000000000d9', 'Hello', 'open', null, '')),
			pg_temp.entry('agents/wendy/agent.md', 'agent', pg_temp.agent_text('70700000-0000-4000-8000-0000000000a4', 'Wendy'), pg_temp.agent_parse('70700000-0000-4000-8000-0000000000a4', 'Wendy'))))));
	if not pg_temp.refused(r) then raise exception 'An owner the unit does not write is no owner: %', r; end if;
	-- A done todo stays done through a delete and a restore.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'restore-0001', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/ship.md', '70700000-0000-4000-8000-0000000000da', 'Ship it', 'done'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'restore-0002', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/otto/todos/ship.md','expectedVersion',pg_temp.version('agents/otto/todos/ship.md')))), 1, 'saved');
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'restore-0003', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/ship.md', '70700000-0000-4000-8000-0000000000da', 'Ship it', 'open')))) then
		raise exception 'A done todo is not opened again by a restore'; end if;
	-- A restore keeps a requester who has since left (the member left in section 3).
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'restore-0004', jsonb_build_array(
		pg_temp.todo('agents/nora-dahl/todos/call-again.md', '70700000-0000-4000-8000-0000000000db', 'Call again', 'open', null))), 1, 'saved');
	update public.qorpera_runtime_agent_todos set requested_by_user_id = '70700000-0000-4000-8000-000000000002' where id = '70700000-0000-4000-8000-0000000000db';
	update public.qorpera_folder_path_versions set structured = jsonb_set(structured, '{parse,requestedBy}', to_jsonb('70700000-0000-4000-8000-000000000002'::text))
	where version = pg_temp.version('agents/nora-dahl/todos/call-again.md');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'restore-0005', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/nora-dahl/todos/call-again.md','expectedVersion',pg_temp.version('agents/nora-dahl/todos/call-again.md')))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'restore-0006', jsonb_build_array(
		pg_temp.todo('agents/nora-dahl/todos/call-again.md', '70700000-0000-4000-8000-0000000000db', 'Call again', 'open', '70700000-0000-4000-8000-000000000002'))), 1, 'saved');
end $$;

-- 7. Ids and shapes ----------------------------------------------------------------------------------------------------

do $$
declare r jsonb;
begin
	-- A runtime todo's id, and another environment's file todo's id, are refused.
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_agent_todos(id, profile_id, environment_id, staff_agent_id, todo_key, title, requested_by_user_id,
		created_by_run_id, updated_by_run_id)
	values ('70700000-0000-4000-8000-0000000000dc', '70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000020', '70700000-0000-4000-8000-0000000000a2', 'runtime', 'From a run', '70700000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), extensions.gen_random_uuid());
	insert into public.qorpera_runtime_agent_todos(id, profile_id, environment_id, staff_agent_id, todo_key, title,
		folder_environment_id, folder_path, folder_path_version, folder_commit_id)
	values ('70700000-0000-4000-8000-0000000000dd', '70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000022', '70700000-0000-4000-8000-0000000000a2', 'elsewhere', 'Elsewhere', '70700000-0000-4000-8000-000000000022', 'agents/otto/todos/elsewhere.md',
		extensions.gen_random_uuid(), extensions.gen_random_uuid());
	set local session_replication_role = origin;
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'ids-0001', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/runtime.md', '70700000-0000-4000-8000-0000000000dc', 'From a run')))) then
		raise exception 'A runtime todo''s id is refused'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'ids-0002', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/elsewhere.md', '70700000-0000-4000-8000-0000000000dd', 'Elsewhere')))) then
		raise exception 'Another environment''s todo id is refused'; end if;
	-- One id twice in one change set: the second file is refused.
	r := pg_temp.commit(pg_temp.owner(), 'ids-0003', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/first-copy.md', '70700000-0000-4000-8000-0000000000de', 'Copy'), pg_temp.todo('agents/otto/todos/second-copy.md', '70700000-0000-4000-8000-0000000000de', 'Copy')));
	perform pg_temp.expect(r, 1, 'saved');
	if coalesce(r -> 'units' -> 1 ->> 'reason', '') is distinct from 'structured_rule' then
		raise exception 'One todo per id across units: %', r; end if;
	-- One id twice inside one unit: a hire that brings two todo files with one id.
	r := pg_temp.commit(pg_temp.owner(), 'ids-0005', jsonb_build_array(jsonb_build_object('op','new_folder','path','agents/zed',
		'contents', jsonb_build_array(jsonb_build_object('path','todos','kind','folder'),
			jsonb_build_object('path','todos/a.md','kind','file','file',pg_temp.stage(pg_temp.todo_text('70700000-0000-4000-8000-0000000000e0', 'A', 'open', null, ''))),
			jsonb_build_object('path','todos/b.md','kind','file','file',pg_temp.stage(pg_temp.todo_text('70700000-0000-4000-8000-0000000000e0', 'A', 'open', null, ''))),
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text('70700000-0000-4000-8000-0000000000a5', 'Zed')))),
		'structured', jsonb_build_array(
			pg_temp.entry('agents/zed/todos/a.md', 'todo', pg_temp.todo_text('70700000-0000-4000-8000-0000000000e0', 'A', 'open', null, ''),
				pg_temp.todo_parse('70700000-0000-4000-8000-0000000000e0', 'A', 'open', null, '')),
			pg_temp.entry('agents/zed/todos/b.md', 'todo', pg_temp.todo_text('70700000-0000-4000-8000-0000000000e0', 'A', 'open', null, ''),
				pg_temp.todo_parse('70700000-0000-4000-8000-0000000000e0', 'A', 'open', null, '')),
			pg_temp.entry('agents/zed/agent.md', 'agent', pg_temp.agent_text('70700000-0000-4000-8000-0000000000a5', 'Zed'),
				pg_temp.agent_parse('70700000-0000-4000-8000-0000000000a5', 'Zed'))))));
	if not pg_temp.refused(r) then raise exception 'One todo id per unit: %', r; end if;
	-- A file the index does not point at is not the saved version: a new id there is a new todo.
	delete from public.qorpera_runtime_agent_todos where id = '70700000-0000-4000-8000-0000000000de';
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'ids-0004', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/first-copy.md', '70700000-0000-4000-8000-0000000000df', 'Copy'))), 1, 'saved');
	-- Shapes: an extra key, a requested_by that is not an id, a detail past 4000 bytes.
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'shape-0001', jsonb_build_array(pg_temp.write('agents/otto/todos/keys.md', 'todo',
		pg_temp.todo_text('70700000-0000-4000-8000-0000000000de', 'Keys', 'open', null, ''), pg_temp.todo_parse('70700000-0000-4000-8000-0000000000de', 'Keys', 'open', null, '') || '{"extra":1}', null))),
		'structured_invalid') then raise exception 'A todo''s parse has exactly its keys'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'shape-0002', jsonb_build_array(pg_temp.write('agents/otto/todos/who.md', 'todo',
		pg_temp.todo_text('70700000-0000-4000-8000-0000000000de', 'Who', 'open', null, ''), pg_temp.todo_parse('70700000-0000-4000-8000-0000000000de', 'Who', 'open', null, '') || '{"requestedBy":"someone"}', null))),
		'structured_invalid') then raise exception 'requested_by is an id'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'shape-0003', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/long-detail.md', '70700000-0000-4000-8000-0000000000de', 'Long', 'open', null, repeat('d', 4001)))), 'structured_invalid') then
		raise exception 'The detail is at most 4000 bytes'; end if;
end $$;

-- 8. Folders whose names share a prefix, and a cancelled todo through a restore -------------------------------------------

do $$
declare r jsonb;
begin
	r := pg_temp.commit(pg_temp.owner(), 'pat-0001', jsonb_build_array(
		pg_temp.hire_todos('pat', '70700000-0000-4000-8000-0000000000b1', jsonb_build_array(jsonb_build_array('x', '70700000-0000-4000-8000-0000000000f1', 'X'), jsonb_build_array('x-y', '70700000-0000-4000-8000-0000000000f2', 'XY'),
			jsonb_build_array('x0', '70700000-0000-4000-8000-0000000000f3', 'X0'))),
		pg_temp.hire_todos('pat-2', '70700000-0000-4000-8000-0000000000b2', jsonb_build_array(jsonb_build_array('t', '70700000-0000-4000-8000-0000000000f4', 'T'))),
		pg_temp.hire_todos('pat0', '70700000-0000-4000-8000-0000000000b3', jsonb_build_array(jsonb_build_array('t', '70700000-0000-4000-8000-0000000000f5', 'T'))),
		pg_temp.hire_todos('pata', '70700000-0000-4000-8000-0000000000b4', jsonb_build_array(jsonb_build_array('t', '70700000-0000-4000-8000-0000000000f6', 'T')))));
	perform pg_temp.expect(r, 4, 'saved');
	-- The siblings have working workers; they never block pat's changes.
	perform pg_temp.working('70700000-0000-4000-8000-0000000000f4', '70700000-0000-4000-8000-0000000000b2');
	perform pg_temp.working('70700000-0000-4000-8000-0000000000f5', '70700000-0000-4000-8000-0000000000b3');
	perform pg_temp.working('70700000-0000-4000-8000-0000000000f6', '70700000-0000-4000-8000-0000000000b4');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'pat-0002', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/pat/todos/x.md','expectedVersion',pg_temp.version('agents/pat/todos/x.md')))), 1, 'saved');
	if (pg_temp.row('70700000-0000-4000-8000-0000000000f1')).folder_retired_at is null or (pg_temp.row('70700000-0000-4000-8000-0000000000f2')).folder_retired_at is not null
		or (pg_temp.row('70700000-0000-4000-8000-0000000000f3')).folder_retired_at is not null then
		raise exception 'Deleting x.md retires x only'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'pat-0003', jsonb_build_array(pg_temp.move('agents/pat', 'agents/pat-b'))), 1, 'saved');
	if (pg_temp.row('70700000-0000-4000-8000-0000000000f2')).folder_path is distinct from 'agents/pat-b/todos/x-y.md'
		or (pg_temp.row('70700000-0000-4000-8000-0000000000f4')).folder_path is distinct from 'agents/pat-2/todos/t.md'
		or (pg_temp.row('70700000-0000-4000-8000-0000000000f6')).folder_path is distinct from 'agents/pata/todos/t.md' then
		raise exception 'A rename moves its own todos only'; end if;
	-- A sibling whose name starts with the deleted folder's name and a hyphen is not in it.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'pat-0035', jsonb_build_array(
		pg_temp.hire_todos('pat-b-2', '70700000-0000-4000-8000-0000000000b5', jsonb_build_array(jsonb_build_array('t', '70700000-0000-4000-8000-0000000000f8', 'T'))))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'pat-0004', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/pat-b','expectedVersion',pg_temp.version('agents/pat-b'),'asOfSeq',pg_temp.seq()))), 1, 'saved');
	if (pg_temp.row('70700000-0000-4000-8000-0000000000f2')).folder_retired_at is null or (pg_temp.row('70700000-0000-4000-8000-0000000000f3')).folder_retired_at is null
		or (pg_temp.row('70700000-0000-4000-8000-0000000000f2')).state is distinct from 'cancelled'
		or (pg_temp.row('70700000-0000-4000-8000-0000000000f4')).folder_retired_at is not null or (pg_temp.row('70700000-0000-4000-8000-0000000000f5')).folder_retired_at is not null
		or (pg_temp.row('70700000-0000-4000-8000-0000000000f6')).folder_retired_at is not null
		or (pg_temp.row('70700000-0000-4000-8000-0000000000f8')).folder_retired_at is not null then
		raise exception 'Deleting an agent''s folder retires and cancels its own todos only'; end if;
	-- A todos folder moved under a folder with no agent would leave its todos without one.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'pat-0045', jsonb_build_array(jsonb_build_object('op','new_folder',
		'path','agents/nobody','contents','[]'::jsonb))), 1, 'saved');
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'pat-0046', jsonb_build_array(
		pg_temp.move('agents/pat-b-2/todos', 'agents/nobody/todos')))) then
		raise exception 'A todos folder moves only to an agent'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'pat-0005', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/pat-2','expectedVersion',pg_temp.version('agents/pat-2'),'asOfSeq',pg_temp.seq())))) then
		raise exception 'A sibling whose todo has a working worker stays'; end if;
	-- A cancelled todo is not opened again by a restore either.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'pat-0006', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/drop.md', '70700000-0000-4000-8000-0000000000f7', 'Drop it', 'cancelled'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'pat-0007', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/otto/todos/drop.md','expectedVersion',pg_temp.version('agents/otto/todos/drop.md')))), 1, 'saved');
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'pat-0008', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/drop.md', '70700000-0000-4000-8000-0000000000f7', 'Drop it', 'open')))) then
		raise exception 'A cancelled todo is not opened again by a restore'; end if;
end $$;

rollback;
